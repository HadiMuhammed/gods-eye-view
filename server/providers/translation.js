const MAX_BODY_BYTES = 64 * 1024;
const MAX_ITEMS = 24;
const MAX_TEXT_LENGTH = 1200;
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

const requestWindows = new Map();

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('body_too_large');
  }
  return JSON.parse(body || '{}');
}

function allowRequest(req, now = Date.now()) {
  const key = req.socket?.remoteAddress || 'unknown';
  const current = requestWindows.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    requestWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_REQUESTS_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

function configuredEndpoint() {
  const value = String(process.env.TRANSLATION_API_URL || '').trim();
  return value ? value.replace(/\/$/, '') : null;
}

function validPayload(payload) {
  const target = String(payload?.target || '').trim().toLowerCase();
  const source = String(payload?.source || 'auto').trim().toLowerCase();
  const texts = Array.isArray(payload?.texts) ? payload.texts : [];
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(target)) return null;
  if (!(source === 'auto' || /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(source))) return null;
  if (texts.length < 1 || texts.length > MAX_ITEMS) return null;
  if (texts.some((text) => typeof text !== 'string' || text.length > MAX_TEXT_LENGTH)) return null;
  return { source, target, texts };
}

async function translateTexts({ endpoint, apiKey, source, target, texts }) {
  const translated = [];
  for (const text of texts) {
    const response = await fetch(`${endpoint}/translate`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ q: text, source, target, format: 'text' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`upstream_${response.status}`);
    const data = await response.json();
    const value = data?.translatedText ?? data?.translation ?? data?.translations?.[0]?.text;
    if (typeof value !== 'string') throw new Error('invalid_translation_response');
    translated.push(value);
  }
  return translated;
}

/** Optional, server-side translation proxy. Disabled unless TRANSLATION_API_URL is set. */
export function translationProxy() {
  return {
    name: 'gev-translation-proxy',
    configureServer(server) {
      server.middlewares.use('/api/translate', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
        if (!configuredEndpoint()) return sendJson(res, 404, { error: 'translation_disabled' });
        if (!allowRequest(req)) return sendJson(res, 429, { error: 'rate_limited' });

        try {
          const payload = validPayload(await readJson(req));
          if (!payload) return sendJson(res, 400, { error: 'invalid_payload' });
          const texts = await translateTexts({
            endpoint: configuredEndpoint(),
            apiKey: String(process.env.TRANSLATION_API_KEY || '').trim(),
            ...payload,
          });
          return sendJson(res, 200, { source: payload.source, target: payload.target, texts });
        } catch (error) {
          console.warn('[Translation] Request failed:', error?.message || error);
          return sendJson(res, 502, { error: 'translation_unavailable' });
        }
      });
    },
  };
}
