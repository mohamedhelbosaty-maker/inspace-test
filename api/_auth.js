// api/_auth.js
// Verifies the Google ID token sent by the browser and enforces the
// @inspace.io domain restriction. Files prefixed with "_" are not
// exposed as routes by Vercel — this is a helper, not an endpoint.
//
// Setup: add an Environment Variable in your Vercel project settings
//   GOOGLE_CLIENT_ID = ....apps.googleusercontent.com
// It must be the SAME client ID that's hardcoded in public/index.html.

const ALLOWED_DOMAIN = 'inspace.io';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo?id_token=';

// Per-instance cache so a warm lambda doesn't re-verify the same token
// on every call. Keyed by token, expires when the token does.
const verified = new Map();

function deny(status, error) {
  return { ok: false, status, error };
}

export async function verifyRequest(req) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return deny(500, 'Server misconfigured: GOOGLE_CLIENT_ID is not set in the environment.');
  }

  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    return deny(401, 'Not signed in.');
  }

  const cached = verified.get(token);
  if (cached && cached.expMs > Date.now()) {
    return { ok: true, email: cached.email };
  }

  let info;
  try {
    const res = await fetch(TOKENINFO_URL + encodeURIComponent(token));
    info = await res.json();
    if (!res.ok) {
      return deny(401, 'Your sign-in is no longer valid. Please sign in again.');
    }
  } catch (err) {
    console.error('tokeninfo lookup failed:', err);
    return deny(503, 'Could not reach Google to verify your sign-in.');
  }

  const expMs = Number(info.exp) * 1000;
  if (!expMs || expMs <= Date.now()) {
    return deny(401, 'Your sign-in has expired. Please sign in again.');
  }

  // The token must have been minted for THIS app, by Google.
  if (info.aud !== clientId) {
    return deny(401, 'That sign-in was issued for a different app.');
  }
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') {
    return deny(401, 'Unrecognised token issuer.');
  }
  if (info.email_verified !== true && info.email_verified !== 'true') {
    return deny(403, 'That Google account has an unverified email address.');
  }

  // hd = hosted domain. Only Google Workspace accounts carry it, so a
  // personal gmail.com account can never satisfy this check.
  const hd = String(info.hd || '').toLowerCase();
  const email = String(info.email || '').toLowerCase();
  if (hd !== ALLOWED_DOMAIN || !email.endsWith('@' + ALLOWED_DOMAIN)) {
    return deny(403, `Glance is limited to @${ALLOWED_DOMAIN} accounts.`);
  }

  if (verified.size > 500) verified.clear();
  verified.set(token, { email, expMs });

  return { ok: true, email };
}
