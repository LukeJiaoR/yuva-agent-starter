const AUTH_BASE = '/api/auth';

export async function authRequest(path, { body, signal, headers } = {}) {
  const response = await fetch(`${AUTH_BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Only use application error codes. Do not expose a provider response, which
    // could contain credentials, mail links, or internal implementation details.
    const error = new Error('Account request failed.');
    error.status = response.status;
    error.code = typeof data.code === 'string' ? data.code : typeof data.error === 'string' ? data.error : 'request_failed';
    throw error;
  }
  return data;
}
