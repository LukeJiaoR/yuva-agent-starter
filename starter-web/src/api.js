const configuredBase = String(import.meta.env.VITE_API_URL || '').replace(/\/$/u, '');

function apiUrl(path) {
  return `${configuredBase}${path}`;
}

async function readJsonResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || 'The request failed.');
    error.code = body.code || body.error || 'request_failed';
    error.financialStatus = body.financial_status;
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function checkReadiness(signal) {
  const response = await fetch(apiUrl('/ready'), { signal, credentials: 'include' });
  return readJsonResponse(response);
}
export async function readPricing(signal) {
  return readJsonResponse(await fetch(apiUrl('/api/pricing'), { signal, credentials: 'include' }));
}

export async function analyzeInput(input, signal) {
  const response = await fetch(apiUrl('/api/analyze'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
    signal,
  });
  return readJsonResponse(response);
}

function parseEventBlock(block) {
  const event = { type: 'message', data: null };
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event.type = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (data.length) {
    try {
      event.data = JSON.parse(data.join('\n'));
    } catch {
      event.data = { data: { text: data.join('\n') } };
    }
  }
  return event;
}

export async function streamChat(payload, { onEvent, signal } = {}) {
  const response = await fetch(apiUrl('/api/chat/stream'), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('text/event-stream')) {
    return readJsonResponse(response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/gu, '\n');
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      if (block.trim()) onEvent?.(parseEventBlock(block));
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent?.(parseEventBlock(buffer));
  return { streamed: true };
}
