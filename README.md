# InSpace · Glance

A live prospect-research tool for cold calls: paste a prospect's website, get a
5-second glance (niche, location, competitor) plus deeper signals (AI platform
visibility, SEO activity, Google rank) to use as your call opener.

## How it's structured

- `public/index.html` — the frontend. Calls `/api/analyze` (relative path,
  same origin) — it never talks to Anthropic directly.
- `api/analyze.js` — a Vercel serverless function. Holds the real Anthropic
  API call server-side, using web search to check AI visibility, SEO signals,
  and estimated Google ranking.

## Deploying to Vercel

1. Push this folder to a GitHub repo.
2. Import the repo into Vercel as a new project (Vercel auto-detects
   `public/` as static output and `api/` as serverless functions — no
   framework config needed).
3. In Vercel → Project Settings → Environment Variables, add:
   - `ANTHROPIC_API_KEY` = your real Anthropic API key
   - Apply to both **Production** and **Preview**
4. Deploy. Without step 3, every analysis request will fail with a 500.

## Notes

- Each analysis is a real Anthropic API call that uses web search — factor
  that into your usage/billing if you expect high call volume.
- The model's AI-visibility and Google-rank readings are directional signals
  for a cold-call opener, not verified analytics.
