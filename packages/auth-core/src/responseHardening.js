export function stripSessionToken(body) {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, 'session_token')
  ) {
    const { session_token: _sessionToken, ...safeBody } = body;
    return safeBody;
  }
  return body;
}

export function hardenJsonResponse(res) {
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(stripSessionToken(body));
}
