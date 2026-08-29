// api/analyze.js
// Vercel Serverless Function — proxies the Gemini API call server-side
// so the real API key never touches the browser.
//
// Setup: in your Vercel project settings, add an Environment Variable
//   GEMINI_API_KEY = AQ... (or AIza..., whichever format your account issues)
// (Project Settings → Environment Variables → Production + Preview)
// Get a free key at https://aistudio.google.com/apikey

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
  "aiProblem": "1 short sentence, plain language, NOT technical — the business problem this creates for the prospect",
  "aiOpportunity": "1 short sentence — a concrete, specific action or content idea they could pursue to fix it",

  "seoActive": "yes" | "no" | "basic",
  "seoProblem": "1 short sentence, plain language — the business problem this creates (e.g. missing traffic, invisible to searchers)",
  "seoOpportunity": "1 short sentence — a concrete, specific content or SEO action, e.g. 'Create guides about X' — never vague technical notes like 'meta tags are present'",

  "googlePageNumber": number — estimated Google page (1, 2, 3, etc.) for their main niche+city keyword. Use web search to check. If rank is unknown default to 3,
  "rankProblem": "1 short sentence, plain language — what being unranked/poorly ranked costs them in real terms",
  "rankOpportunity": "1 short sentence — what would move the needle, ideally naming the specific keyword and competitor beating them",

  "openingLine": "ONE sentence the SDR reads aloud almost word-for-word on a live call. MUST follow this exact structure in order: (1) a specific search query in quotes, (2) the competitor or missed opportunity found instead, (3) the prospect's problem, (4) the business impact. Pattern: 'If someone searches \\'[specific query]\\' on [Google/ChatGPT/etc], [competitor] shows up — but [Company] doesn't. That means [business impact].' Must be short enough to read in a few seconds, natural when spoken aloud, zero interpretation required, no unexplained jargon. This is the single most important field — get it right."
}

Use your web search tool to:
1. Search '[niche] [city]' on Google to estimate their page ranking and find the actual competitor beating them for that exact query.
2. Search the company name on ChatGPT, Perplexity, or check if they appear in AI recommendation contexts for their niche.
3. Check their site for SEO signals (meta tags, blog, schema markup) — but only to inform the Problem/Opportunity fields, never report raw technical findings.

Hard rules:
- Every Problem field must describe a business consequence (lost customers, invisible to searchers, confused positioning), never a technical fact on its own (e.g. never just "meta tags are missing").
- Every Opportunity field must be a specific, actionable idea (a content topic, a positioning fix, a keyword to target) — never generic advice like "improve SEO."
- The test for every field: would an SDR be able to say this out loud on a call and have it make sense? If not, rewrite it until it passes that test.
- If you can't verify something, make a reasonable, specific inference — never leave a field vague.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
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
                text: `Analyze this prospect website and check their AI visibility, SEO activity, and Google ranking: ${parsed.toString()}`,
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
