// api/analyze.js
// Vercel Serverless Function — proxies the Gemini API call server-side
// so the real API key never touches the browser.
//
// Setup: in your Vercel project settings, add an Environment Variable
//   GEMINI_API_KEY = AQ... (or AIza..., whichever format your account issues)
// (Project Settings → Environment Variables → Production + Preview)
// Get a free key at https://aistudio.google.com/apikey

import { verifyRequest } from './_auth.js';

export const config = {
  runtime: 'nodejs',
};

const GEMINI_MODEL = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `You are an AI-powered SDR conversation assistant with web search access. Your job is NOT to produce an SEO audit — it is to turn raw signals into a ready-to-use sales conversation. Analyze the prospect website thoroughly and return ONLY a valid JSON object, no markdown, no extra text, no code fences.

Required fields:
{
  "companyName": "string — real company name",
  "businessType": "service" or "product",
  "niche": "2-4 word niche, lowercase, e.g. 'residential plumbing'",
  "city": "city/region they serve, or 'your area' if unclear",
  "competitor": "one plausible real or realistic competitor brand in same niche",

  "aiVisibility": "yes" | "no" | "partial",
  "aiTalkingPoint": "4-8 word phrase the rep can say out loud — what this means for the prospect, not a technical finding. e.g. 'Competitors get recommended, you don't'",

  "seoActive": "yes" | "no" | "basic",
  "seoTalkingPoint": "4-8 word phrase — e.g. 'Blog posts stopped in 2023'",

  "googlePageNumber": number — estimated Google page (1, 2, 3, etc.) for their main niche+city keyword. Use web search to check. If rank is unknown default to 3,
  "rankTalkingPoint": "4-8 word phrase, name the keyword or competitor when it fits — e.g. 'Beaten by [competitor] on [keyword]'",

  "paidAdsActive": "yes" | "no" | "unclear",
  "organicStrength": "strong" | "moderate" | "weak",
  "paidVsOrganicNote": "1-2 short, warm, plain-language sentences comparing their paid ad spend against their organic/SEO reach — simple and conversational, e.g. explaining if they're paying for clicks they could be getting for free, or under-investing in ads for a fast niche",

  "openingLine": "Follow this exact template, filling in the brackets naturally: 'I was searching for [niche] on AI platforms like ChatGPT, Gemini, and Claude, and it was hard to find you. I found you though, on Google, on page [X]. It looks like you're doing some SEO work, so I was wondering — is there someone helping you get recommended by AI?' Keep the tone warm and genuinely curious, never accusatory. Adjust small grammar naturally if googlePageNumber is 1 (e.g. 'right on the first page' instead of 'page 1' sounding odd). This is the single most important field — match this template closely."
}

Use your web search tool to:
1. Search '[niche] [city]' on Google to estimate their page ranking and find the actual competitor beating them for that exact query.
2. Search the company name on ChatGPT, Perplexity, or check if they appear in AI recommendation contexts for their niche.
3. Check their site for SEO signals (meta tags, blog, schema markup) and any visible paid advertising presence (Google Ads, social ads) to inform the talking points and Paid vs Organic fields.

Hard rules:
- The three talkingPoint fields are SHORT PHRASES (4-8 words), not sentences. They sit next to a status label the rep is already reading, so never restate the status — if AI Visibility says "Not Found", the talking point adds why that costs them, it doesn't repeat that they're not found.
- Every phrase must describe a real business consequence or a specific action — never vague technical jargon like "meta tags are missing."
- The openingLine is the one thing read aloud word-for-word — it should be a full, natural sentence following the template above.
- The paidVsOrganicNote is friendly and conversational — written like a helpful observation, not a report finding.
- If you can't verify something, make a reasonable, specific inference — never leave a field vague.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // Gate: only signed-in @inspace.io accounts get past here.
  const auth = await verifyRequest(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server misconfigured: GEMINI_API_KEY is not set in the environment.',
    });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url" in request body.' });
  }

  let parsed;
  try {
    parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' });
  }

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    const geminiRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Analyze this prospect website and check their AI visibility, SEO activity, Google ranking, and paid vs organic presence: ${parsed.toString()}`,
              },
            ],
          },
        ],
        tools: [{ google_search: {} }],
        generationConfig: {
          maxOutputTokens: 2048,
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Gemini API non-OK response:', JSON.stringify(data));
      const detail = data?.error?.details
        ? JSON.stringify(data.error.details)
        : '';
      return res.status(geminiRes.status).json({
        error: `${data?.error?.message || 'Gemini API request failed.'}${detail ? ' | ' + detail : ''}`,
      });
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || '')
      .join('\n');

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      const finishReason = data.candidates?.[0]?.finishReason || 'unknown';
      return res.status(502).json({
        error: `Could not parse a JSON result from the model response (finishReason: ${finishReason}).`,
      });
    }

    let parsedResult;
    try {
      parsedResult = JSON.parse(match[0]);
    } catch {
      return res.status(502).json({ error: 'Model returned malformed JSON.' });
    }

    return res.status(200).json(parsedResult);
  } catch (err) {
    console.error('Gemini API error:', err);
    return res.status(500).json({ error: 'Unexpected server error calling Gemini API.' });
  }
}
