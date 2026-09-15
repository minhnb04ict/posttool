const APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbyDUDJO4T3KKsigwpcG6XrlHo4hs9kZ7sYvAn2R1y6WClQjy_rqA8YWvF9EjQmRjiWg/exec';

function withQuery(query = {}) {
  const url = new URL(APPS_SCRIPT_URL);
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)));
    else if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  url.searchParams.set('_posttoolTs', String(Date.now()));
  return url.toString();
}

async function getRaw(query = {}) {
  const response = await fetch(withQuery(query), {
    method: 'GET',
    redirect: 'follow',
    headers: { Accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(30000)
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || 'application/json; charset=utf-8',
    body: await response.text()
  };
}

async function postRaw(payload) {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8',
      Accept: 'application/json, text/plain, */*'
    },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(60000)
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || 'application/json; charset=utf-8',
    body: await response.text()
  };
}

async function postJson(payload) {
  const raw = await postRaw(payload);
  let data;
  try { data = JSON.parse(raw.body); }
  catch (_) { throw new Error('Google Apps Script không trả JSON hợp lệ.'); }
  if (raw.status < 200 || raw.status >= 300 || data?.ok === false) {
    throw new Error(data?.error || `Google Apps Script HTTP ${raw.status}`);
  }
  return data;
}

module.exports = {
  APPS_SCRIPT_URL,
  getRaw,
  postRaw,
  postJson
};
