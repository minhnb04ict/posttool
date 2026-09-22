const https = require('https');
const axios = require('axios');

const APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbyDUDJO4T3KKsigwpcG6XrlHo4hs9kZ7sYvAn2R1y6WClQjy_rqA8YWvF9EjQmRjiWg/exec';

const DEFAULT_TIMEOUT_MS = Math.max(5000, Number(process.env.GAS_TIMEOUT_MS || 45000));
const DEFAULT_RETRIES = Math.max(0, Math.min(4, Number(process.env.GAS_RETRIES || 2)));

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  timeout: 30000
});

const client = axios.create({
  maxRedirects: 5,
  httpsAgent,
  responseType: 'text',
  transformResponse: [(data) => data],
  maxContentLength: 32 * 1024 * 1024,
  maxBodyLength: 32 * 1024 * 1024,
  headers: {
    Accept: 'application/json, text/plain, */*'
  },
  validateStatus: () => true
});

function withQuery(query = {}) {
  const url = new URL(APPS_SCRIPT_URL);
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)));
    else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function errorStatus(error) {
  return Number(error?.response?.status || 0);
}

function retryDelay(attempt) {
  const base = Math.min(2200, 300 * (2 ** attempt));
  const jitter = Math.floor(Math.random() * 240);
  return base + jitter;
}

async function requestText(config, { retries = DEFAULT_RETRIES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await client.request({
        ...config,
        timeout: timeoutMs
      });

      const body = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data ?? '');

      if (!retryableStatus(response.status) || attempt >= retries) {
        return {
          status: response.status,
          contentType: response.headers?.['content-type'] || 'application/json; charset=utf-8',
          body
        };
      }

      lastError = new Error(`Google Apps Script HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      const status = errorStatus(error);
      const retryable = !status || retryableStatus(status) || error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET';
      if (!retryable || attempt >= retries) throw error;
    }

    await sleep(retryDelay(attempt));
  }

  throw lastError || new Error('Google Apps Script request failed.');
}

async function getRaw(query = {}, options = {}) {
  return requestText({
    url: withQuery(query),
    method: 'GET'
  }, options);
}

async function postRaw(payload, options = {}) {
  return requestText({
    url: APPS_SCRIPT_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
      Accept: 'application/json, text/plain, */*'
    },
    data: JSON.stringify(payload ?? {})
  }, { timeoutMs: Math.max(DEFAULT_TIMEOUT_MS, 60000), ...options });
}

async function postJson(payload, options = {}) {
  const raw = await postRaw(payload, options);
  let data;
  try {
    data = JSON.parse(raw.body);
  } catch (_) {
    const preview = String(raw.body || '').replace(/\s+/g, ' ').slice(0, 180);
    throw new Error(`Google Apps Script không trả JSON hợp lệ${preview ? `: ${preview}` : ''}`);
  }

  if (raw.status < 200 || raw.status >= 300 || data?.ok === false) {
    const error = new Error(data?.error || `Google Apps Script HTTP ${raw.status}`);
    error.status = raw.status;
    throw error;
  }
  return data;
}

async function health() {
  const startedAt = Date.now();
  try {
    const raw = await getRaw({ action: 'health' }, { retries: 0, timeoutMs: 10000 });
    const data = JSON.parse(raw.body);
    return {
      ok: raw.status >= 200 && raw.status < 300 && data?.ok !== false,
      status: raw.status,
      latencyMs: Date.now() - startedAt,
      service: data?.service || '',
      transport: 'axios'
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: error.message, transport: 'axios' };
  }
}

module.exports = {
  APPS_SCRIPT_URL,
  getRaw,
  postRaw,
  postJson,
  health
};
