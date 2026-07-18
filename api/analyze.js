// api/analyze.js
// Vercel Serverless Function — proxies the Anthropic API call server-side
// so the real API key never touches the browser.
//
// Setup: in your Vercel project settings, add an Environment Variable
//   ANTHROPIC_API_KEY = sk-ant-...
// (Project Settings → Environment Variables → Production + Preview)

export const config = {
  runtime: 'nodejs',
};

const SYSTEM_PROMPT = `You are an elite SDR analyst with web search access. Analyze the prospect website thoroughly and return ONLY a valid JSON object, no markdown, no extra text.

Required fields:
{
  "companyName": "string — real company name",
  "businessType": "service" or "product",
  "niche": "2-4 word niche, lowercase, e.g. 'residential plumbing'",
  "city": "city/region they serve, or 'your area' if unclear",
  "competitor": "one plausible real or realistic competitor brand in same niche",

  "aiVisibility": "yes" | "no" | "partial",
  "aiVisibilityNote": "1 short sentence — which AI platforms mention them (ChatGPT/Perplexity/etc) or why they don't show up",

  "seoActive": "yes" | "no" | "basic",
  "seoNote": "1 short sentence — evidence of SEO: blog, meta tags, structured data, backlinks, etc. or lack thereof",

  "googlePageNumber": number — estimated Google page (1, 2, 3, etc.) for their main niche+city keyword. Use web search to check. If rank is unknown default to 3,
  "googleRankNote": "1 short sentence — what keyword you checked and what you found"
}

Use your web search tool to:
1. Search '[niche] [city]' on Google to estimate their page ranking.
2. Search the company name on Perplexity or check if they appear in AI recommendation contexts.
3. Check their site for SEO signals (meta tags, blog, schema markup).

Be specific and honest. If you can't verify something, make a reasonable inference and note it.`;

export default async function handler(req, res) {
  // CORS / method guard
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server misconfigured: ANTHROPIC_API_KEY is not set in the environment.',
    });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url" in request body.' });
  }

  // Basic URL validation
  let parsed;
  try {
    parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' });
  }

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          {
            role: 'user',
            content: `Analyze this prospect website and check their AI visibility, SEO activity, and Google ranking: ${parsed.toString()}`,
          },
        ],
      }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      return res.status(anthropicRes.status).json({
        error: data?.error?.message || 'Anthropic API request failed.',
      });
    }

    const text = (data.content || [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(502).json({ error: 'Could not parse a JSON result from the model response.' });
    }

    let parsedResult;
    try {
      parsedResult = JSON.parse(match[0]);
    } catch {
      return res.status(502).json({ error: 'Model returned malformed JSON.' });
    }

    return res.status(200).json(parsedResult);
  } catch (err) {
    console.error('Anthropic API error:', err);
    return res.status(500).json({ error: 'Unexpected server error calling Anthropic API.' });
  }
}
