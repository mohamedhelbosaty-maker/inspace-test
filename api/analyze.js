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

const SYSTEM_PROMPT = `You are an elite SDR analyst with web search access. Analyze the prospect website thoroughly and return ONLY a valid JSON object, no markdown, no extra text, no code fences.

Required fields:
{
  "companyName": "string — real company name",
  "businessType": "service" or "product",
  "niche": "2-4 word niche, lowercase, e.g. 'residential plumbing'",
  "city": "city/region they serve, or 'your area' if unclear",
  "competitor": "one plausible real or realistic competitor brand in same niche",

  "aiVisibility": "yes" | "no" | "partial",
  "aiVisibilityNote": "1–2 short sentences — tactical problem they don't know they have, not a research finding",

  "seoActive": "yes" | "no" | "basic",
  "seoNote": "1–2 short sentences — specific gap they could fill or improvement they could make. E.g. 'Their blog could use articles about X' or 'They're missing meta descriptions on key service pages'",

  "googlePageNumber": number — estimated Google page (1, 2, 3, etc.) for their main niche+city keyword. Use web search to check. If rank is unknown default to 3,
  "googleRankNote": "1–2 short sentences — why this ranking matters for their business or what they're missing",

  "openingLine": "one punchy sentence the SDR can say verbatim on the call. Pattern: If [keyword + location] on [AI/Google], [competitor] shows up, you don't. Frame as a problem or gap they didn't know existed. No question marks, no wishy-washy language. Make it land in one breath."
}

Use your web search tool to:
1. Search '[niche] [city]' on Google to estimate their page ranking.
2. Search the company name on ChatGPT, Perplexity, or check if they appear in AI recommendation contexts.
3. Check their site for SEO signals (meta tags, blog, schema markup).

Be specific and honest. Focus on what the SDR can USE — gaps to fill, problems to highlight, competitors winning where they're not. Write for the call, not for research. If you can't verify something, make a reasonable inference and note it.`;

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
      return res.status(geminiRes.status).json({
        error: data?.error?.message || 'Gemini API request failed.',
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
