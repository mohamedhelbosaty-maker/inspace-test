// api/analyze.js
// Vercel Serverless Function — proxies the Kimi (Moonshot AI) API call
// server-side so the real API key never touches the browser.
//
// Setup: in your Vercel project settings, add an Environment Variable
//   MOONSHOT_API_KEY = sk-...
// (Project Settings → Environment Variables → Production + Preview)
// Get a key at https://platform.moonshot.ai (requires a $1 minimum top-up
// to activate — Kimi has no free tier, unlike Gemini's free tier).

export const config = {
  runtime: 'nodejs',
};

// kimi-k2.6, not kimi-k3 — k3 has a known bug where the web-search
// tool-result echo fails with "tokenization failed" (400 error).
const KIMI_MODEL = 'kimi-k2.6';
const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1/chat/completions';
const MAX_TOOL_LOOPS = 5;

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
2. Search the company name to check if they appear in AI recommendation contexts for their niche.
3. Check their site for SEO signals (meta tags, blog, schema markup) — but only to inform the Problem/Opportunity fields, never report raw technical findings.

Hard rules:
- Every Problem field must describe a business consequence (lost customers, invisible to searchers, confused positioning), never a technical fact on its own.
- Every Opportunity field must be a specific, actionable idea, never generic advice like "improve SEO."
- The test for every field: would an SDR be able to say this out loud on a call and have it make sense? If not, rewrite it until it passes that test.
- After your searches, respond with ONLY the JSON object — no other text, no markdown fences.
- If you can't verify something, make a reasonable, specific inference — never leave a field vague.`;

async function callKimi(apiKey, messages) {
  const res = await fetch(MOONSHOT_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: KIMI_MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 2048,
      thinking: { type: 'disabled' }, // required for $web_search compatibility on k2.6
      tools: [
        {
          type: 'builtin_function',
          function: { name: '$web_search' },
        },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || 'Kimi API request failed.');
    err.status = res.status;
    err.raw = data;
    throw err;
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.MOONSHOT_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server misconfigured: MOONSHOT_API_KEY is not set in the environment.',
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

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Analyze this prospect website and check their AI visibility, SEO activity, and Google ranking: ${parsed.toString()}`,
    },
  ];

  try {
    let choice = null;
    let loops = 0;

    while (loops < MAX_TOOL_LOOPS) {
      loops++;
      const data = await callKimi(apiKey, messages);
      choice = data.choices?.[0];
      if (!choice) throw new Error('Kimi API returned no choices.');

      if (choice.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length) {
        // Echo the assistant's tool-call message back into the conversation,
        // then answer each tool call. For $web_search, Moonshot executes the
        // search server-side — we just echo the arguments back as-is.
        messages.push(choice.message);
        for (const toolCall of choice.message.tool_calls) {
          let toolResultContent;
          if (toolCall.function?.name === '$web_search') {
            toolResultContent = toolCall.function.arguments;
          } else {
            toolResultContent = JSON.stringify({ error: `Unknown tool: ${toolCall.function?.name}` });
          }
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function?.name,
            content: toolResultContent,
          });
        }
        continue; // loop again with the tool result included
      }

      break; // got a final, non-tool-call answer
    }

    if (!choice) {
      return res.status(502).json({ error: 'Kimi API did not return a usable response.' });
    }

    const text = choice.message?.content || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(502).json({
        error: `Could not parse a JSON result from the model response (finish_reason: ${choice.finish_reason || 'unknown'}).`,
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
    console.error('Kimi API error:', err?.raw ? JSON.stringify(err.raw) : err);
    return res.status(err?.status || 500).json({
      error: err?.message || 'Unexpected server error calling Kimi API.',
    });
  }
}
