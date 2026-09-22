const gas = require('./googleAppsScript');

const FRESH_MS = Math.max(1000, Number(process.env.TASK_CACHE_TTL_MS || 2000));
const STALE_MS = Math.max(FRESH_MS, Number(process.env.TASK_STALE_MS || 5 * 60 * 1000));
const UPSTREAM_TIMEOUT_MS = Math.max(4000, Number(process.env.TASK_UPSTREAM_TIMEOUT_MS || 10000));
const UPSTREAM_RETRIES = Math.max(0, Math.min(3, Number(process.env.TASK_UPSTREAM_RETRIES || 2)));

const cache = new Map();
const inFlight = new Map();

function stableQuery(query = {}) {
  const copy = {};
  Object.keys(query).sort().forEach(key => {
    if (key === '_ts' || key === '_posttoolTs') return;
    copy[key] = query[key];
  });
  return JSON.stringify(copy);
}

function looksSuccessful(upstream) {
  if (!upstream || upstream.status < 200 || upstream.status >= 300) return false;
  try {
    const data = JSON.parse(upstream.body);
    return data?.ok !== false;
  } catch (_) {
    return false;
  }
}

async function fetchFresh(query, key) {
  const upstream = await gas.getRaw(query, {
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    retries: UPSTREAM_RETRIES
  });

  if (!looksSuccessful(upstream)) {
    const error = new Error(`Google Apps Script trả dữ liệu không hợp lệ hoặc HTTP ${upstream?.status || 0}.`);
    error.upstream = upstream;
    throw error;
  }

  const now = Date.now();
  const entry = {
    ...upstream,
    fetchedAt: now,
    freshUntil: now + FRESH_MS,
    staleUntil: now + STALE_MS
  };
  cache.set(key, entry);
  return entry;
}

async function getTask(query = {}, { force = false } = {}) {
  const key = stableQuery(query);
  const now = Date.now();
  const existing = cache.get(key);

  if (!force && existing && now < existing.freshUntil) {
    return { ...existing, cacheStatus: 'HIT' };
  }

  if (inFlight.has(key)) {
    try {
      const shared = await inFlight.get(key);
      return { ...shared, cacheStatus: 'COALESCED' };
    } catch (error) {
      if (existing && now < existing.staleUntil) {
        return { ...existing, cacheStatus: 'STALE' };
      }
      throw error;
    }
  }

  const promise = fetchFresh(query, key);
  inFlight.set(key, promise);
  try {
    const fresh = await promise;
    return { ...fresh, cacheStatus: existing ? 'REFRESH' : 'MISS' };
  } catch (error) {
    if (existing && now < existing.staleUntil) {
      return { ...existing, cacheStatus: 'STALE' };
    }
    throw error;
  } finally {
    inFlight.delete(key);
  }
}

function stats() {
  return {
    entries: cache.size,
    inFlight: inFlight.size,
    freshMs: FRESH_MS,
    staleMs: STALE_MS,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    upstreamRetries: UPSTREAM_RETRIES
  };
}

module.exports = { getTask, stats };
