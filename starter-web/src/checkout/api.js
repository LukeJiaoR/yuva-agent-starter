// Use the same-origin cookie/JSON convention as the account client. Browsers
// supply Origin on POST; the backend validates it against trusted auth origins.
const BASE = '/api/mock-checkout';
export async function checkoutRequest(path, { body, signal } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'include',
    cache: 'no-store', referrerPolicy: 'no-referrer', signal,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.mock !== true) {
    const error = new Error('Demo order request could not be confirmed.');
    error.status = response.status;
    error.code = typeof data?.error === 'string' ? data.error : 'request_failed';
    throw error;
  }
  return data;
}
