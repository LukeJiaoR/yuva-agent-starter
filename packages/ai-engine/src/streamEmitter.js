export class StreamDisconnectedError extends Error {
  constructor(message = "Stream client disconnected") {
    super(message);
    this.name = "StreamDisconnectedError";
    this.code = "client_disconnect";
  }
}

export const AssistantStreamDisconnectedError = StreamDisconnectedError;

/**
 * Creates a generic event stream state machine for SSE responses.
 */
export function createStreamEmitter({
  version = "1.0",
  requestId,
  pipelineRunId,
  write,
  isOpen = () => true,
  validateEvent = () => true,
  validateStream = () => true,
  terminalEventType = "done",
}) {
  const events = [];
  let terminal = false;

  return {
    get events() {
      return [...events];
    },
    get started() {
      return events.length > 0;
    },
    get terminal() {
      return terminal;
    },
    emit(type, data) {
      if (terminal) throw new Error("Stream is already terminal");
      const event = {
        version,
        ...(requestId ? { request_id: requestId } : {}),
        ...(pipelineRunId ? { pipeline_run_id: pipelineRunId } : {}),
        event_index: events.length,
        type,
        data,
      };
      if (typeof validateEvent === "function") {
        validateEvent(event);
      }
      const candidate = [...events, event];
      if (type === terminalEventType && typeof validateStream === "function") {
        validateStream(candidate);
      }
      if (!isOpen()) throw new StreamDisconnectedError();
      write(event);
      events.push(event);
      if (type === terminalEventType) terminal = true;
      return event;
    },
  };
}

export const createAssistantStreamEmitter = createStreamEmitter;

/**
 * Formats and writes an SSE event to an HTTP response stream.
 */
export function writeSseEvent(res, event) {
  if (res.destroyed || res.writableEnded) throw new StreamDisconnectedError();
  res.write(`event: ${event.type}\nid: ${event.event_index}\ndata: ${JSON.stringify(event)}\n\n`);
}

export const writeAssistantSseEvent = writeSseEvent;

/**
 * Sets standard headers for SSE streaming over HTTP.
 */
export function setSseHeaders(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

export const setAssistantSseHeaders = setSseHeaders;
