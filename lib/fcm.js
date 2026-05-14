const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SERVICE_ACCOUNT = path.join(__dirname, '..', 'secrets', 'firebase-service-account.json');
let cachedAccount = null;
let cachedAccessToken = null;

function base64url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input));
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function serviceAccountPath() {
  return process.env.FIREBASE_SERVICE_ACCOUNT || DEFAULT_SERVICE_ACCOUNT;
}

function getServiceAccount() {
  if (cachedAccount) return cachedAccount;
  const fp = serviceAccountPath();
  if (!fs.existsSync(fp)) return null;
  cachedAccount = JSON.parse(fs.readFileSync(fp, 'utf8'));
  return cachedAccount;
}

function isConfigured() {
  const sa = getServiceAccount();
  return !!(sa && sa.project_id && sa.client_email && sa.private_key);
}

async function getAccessToken() {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60000) return cachedAccessToken.token;
  const sa = getServiceAccount();
  if (!sa) throw new Error('Firebase service account not found');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64url(header)}.${base64url(claim)}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key);
  const jwt = `${unsigned}.${base64url(signature)}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error || 'Firebase token request failed');
  cachedAccessToken = {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(60, Number(json.expires_in || 3600) - 60) * 1000
  };
  return cachedAccessToken.token;
}

async function sendToToken(token, payload) {
  const sa = getServiceAccount();
  if (!sa) throw new Error('Firebase service account not found');
  const accessToken = await getAccessToken();
  const data = Object.fromEntries(Object.entries(payload.data || {}).map(([k, v]) => [String(k), String(v)]));
  const message = {
    token,
    notification: { title: payload.title || 'Daraja', body: payload.body || '' },
    data,
    webpush: { fcm_options: { link: payload.link || '/app/' } },
    android: { priority: 'HIGH', notification: { channel_id: 'daraja_updates' } }
  };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, response: json };
}

async function sendMulticast(tokens, payload) {
  const results = [];
  for (const token of tokens) {
    try {
      results.push({ token, ...(await sendToToken(token, payload)) });
    } catch (error) {
      results.push({ token, ok: false, error: error.message });
    }
  }
  return {
    attempted: tokens.length,
    success: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    results
  };
}

module.exports = { isConfigured, sendMulticast };
