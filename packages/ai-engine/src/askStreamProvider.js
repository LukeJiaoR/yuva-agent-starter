import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  Output,
  RetryError,
  generateText,
  jsonSchema,
  streamText,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { normalizeSdkProviderResult } from "./providerUsage.js";

const OPENAI_PROVIDER_NAME = "openai";
const PROVIDER_TEXT_MAX_BYTES = 2 * 1024 * 1024;
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high"]);

export class AskProviderStreamError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = "AskProviderStreamError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function providerError(code, message, options) {
  return new AskProviderStreamError(code, message, options);
}

function retryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function positiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveMaxOutputTokens(options = {}) {
  const defaultMaxTokens = positiveInteger(options.maxOutputTokensDefault) || 1024;
  const requestedMaxTokens = positiveInteger(options.maxOutputTokens) || defaultMaxTokens;
  const maxOutputTokensCap = positiveInteger(options.maxOutputTokensCap);
  return maxOutputTokensCap
    ? Math.min(requestedMaxTokens, maxOutputTokensCap)
    : requestedMaxTokens;
}

function openAIProviderOptions(reasoningEffort) {
  if (reasoningEffort !== undefined && reasoningEffort !== null && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`Unsupported reasoning effort: ${reasoningEffort}`);
  }
  return {
    [OPENAI_PROVIDER_NAME]: {
      store: false,
      ...(reasoningEffort === undefined || reasoningEffort === null ? {} : { reasoningEffort }),
    },
  };
}

function normalizeBaseUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/u, "");
  for (const suffix of ["/chat/completions", "/responses"]) {
    if (normalized.endsWith(suffix)) return normalized.slice(0, -suffix.length);
  }
  return normalized;
}

export function createProviderModel({
  provider,
  apiKey,
  baseUrl,
  model,
  fetchFn,
  openAIProviderFactory = createOpenAI,
  anthropicProviderFactory = createAnthropic,
}) {
  if (provider === "anthropic") {
    const anthropic = anthropicProviderFactory({
      apiKey,
      ...(fetchFn ? { fetch: fetchFn } : {}),
    });
    return {
      provider: "anthropic",
      model: anthropic(model),
      providerOptions: undefined,
    };
  }

  const openAI = openAIProviderFactory({
    apiKey,
    baseURL: normalizeBaseUrl(baseUrl),
    ...(fetchFn ? { fetch: fetchFn } : {}),
  });
  return {
    provider: "openai",
    model: openAI.responses(model),
    providerOptions: undefined,
  };
}

function unwrapSdkError(error) {
  if (RetryError.isInstance(error) && error.lastError) return error.lastError;
  return error;
}

function normalizeSdkError(error, signal) {
  if (error instanceof AskProviderStreamError) return error;
  const unwrapped = unwrapSdkError(error);
  if (signal?.aborted || error?.name === "AbortError" || unwrapped?.name === "AbortError") {
    return providerError("provider_aborted", "Provider generation was aborted", { retryable: true });
  }
  if (APICallError.isInstance(unwrapped)) {
    const status = Number.isInteger(unwrapped.statusCode) ? unwrapped.statusCode : null;
    if (status !== null) {
      return providerError("provider_http_error", `Provider returned HTTP ${status}`, {
        status,
        retryable: retryableHttpStatus(status),
      });
    }
    return providerError("provider_connection_error", "Provider connection failed", {
      retryable: true,
    });
  }
  if (
    EmptyResponseBodyError.isInstance(unwrapped)
    || InvalidResponseDataError.isInstance(unwrapped)
    || JSONParseError.isInstance(unwrapped)
  ) {
    return providerError("provider_protocol_error", "Provider returned an invalid response");
  }
  return providerError("provider_protocol_error", "Provider generation failed");
}

function assertSupportedContent(content = [], finishReason) {
  if (finishReason === "tool-calls") {
    throw providerError("provider_protocol_error", "Provider returned an unsupported tool call");
  }
  const unsupported = content.some((part) => !["text", "reasoning"].includes(part?.type));
  if (unsupported) {
    throw providerError("provider_protocol_error", "Provider returned unsupported non-text content");
  }
  const hasText = content.some((part) => part?.type === "text" && part.text);
  const hasNonText = content.some((part) => part?.type !== "text");
  if (!hasText && hasNonText) {
    throw providerError("provider_protocol_error", "Provider returned non-text-only output");
  }
}

function normalizedResult({ provider, requestedModel, sdkResult }) {
  assertSupportedContent(sdkResult?.content, sdkResult?.finishReason);
  if (Buffer.byteLength(String(sdkResult?.text || ""), "utf8") > PROVIDER_TEXT_MAX_BYTES) {
    throw providerError("provider_protocol_error", "Provider response exceeded the safety limit");
  }
  return normalizeSdkProviderResult(sdkResult, {
    provider,
    model: requestedModel,
  });
}

function commonCallOptions({ providerConfig, systemPrompt, messages, options, signal }) {
  const responseFormat = options.responseFormat?.type === "json_schema"
    ? options.responseFormat.json_schema
    : null;
  return {
    model: providerConfig.model,
    system: systemPrompt || undefined,
    messages,
    maxOutputTokens: resolveMaxOutputTokens(options),
    maxRetries: 0,
    abortSignal: signal,
    ...(responseFormat?.schema ? {
      output: Output.object({
        name: responseFormat.name,
        schema: jsonSchema(responseFormat.schema),
      }),
    } : {}),
    ...(Number.isFinite(options.temperature) ? { temperature: options.temperature } : {}),
    ...(providerConfig.provider === "openai"
      ? { providerOptions: openAIProviderOptions(options.reasoningEffort) }
      : {}),
  };
}

export async function generateProviderText({
  provider = "openai",
  fetchFn,
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  messages,
  options = {},
  signal,
  generate = generateText,
  modelFactory = createProviderModel,
}) {
  try {
    const providerConfig = modelFactory({
      provider,
      fetchFn,
      baseUrl,
      apiKey,
      model,
    });
    const sdkResult = await generate(commonCallOptions({
      providerConfig,
      systemPrompt,
      messages,
      options,
      signal,
    }));
    return normalizedResult({ provider: providerConfig.provider, requestedModel: model, sdkResult });
  } catch (error) {
    throw normalizeSdkError(error, signal);
  }
}

const SUPPORTED_STREAM_PARTS = new Set([
  "start",
  "start-step",
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "finish-step",
  "finish",
]);

export async function streamProviderText({
  provider = "openai",
  fetchFn,
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  messages,
  options = {},
  onText,
  signal,
  stream = streamText,
  modelFactory = createProviderModel,
}) {
  try {
    const providerConfig = modelFactory({
      provider,
      fetchFn,
      baseUrl,
      apiKey,
      model,
    });
    const sdkStream = stream(commonCallOptions({
      providerConfig,
      systemPrompt,
      messages,
      options,
      signal,
    }));
    let finish = null;
    let finalStep = null;
    let totalBytes = 0;
    let sawText = false;
    let sawReasoning = false;

    for await (const part of sdkStream.stream || sdkStream.fullStream) {
      if (part.type === "error") throw part.error;
      if (part.type === "abort") {
        throw providerError("provider_aborted", "Provider generation was aborted", { retryable: true });
      }
      if (!SUPPORTED_STREAM_PARTS.has(part.type)) {
        throw providerError("provider_protocol_error", "Provider returned unsupported non-text content");
      }
      if (part.type === "text-delta") {
        sawText ||= Boolean(part.text);
        totalBytes += Buffer.byteLength(part.text || "", "utf8");
        if (totalBytes > PROVIDER_TEXT_MAX_BYTES) {
          throw providerError("provider_protocol_error", "Provider response exceeded the safety limit");
        }
        if (part.text) await onText(part.text);
      } else if (part.type === "finish-step") {
        finalStep = part;
      } else if (part.type === "finish") {
        finish = part;
      } else if (part.type === "reasoning-delta") {
        sawReasoning ||= Boolean(part.text);
      }
    }

    if (!finish || !finalStep) {
      throw providerError("incomplete_provider_stream", "Provider stream ended before SDK completion", {
        retryable: true,
      });
    }
    if (!sawText && sawReasoning) {
      throw providerError("provider_protocol_error", "Provider returned non-text-only output");
    }
    return normalizedResult({
      provider: providerConfig.provider,
      requestedModel: model,
      sdkResult: {
        text: "",
        content: [],
        finishReason: finish.finishReason,
        rawFinishReason: finish.rawFinishReason,
        usage: finish.totalUsage,
        response: finalStep.response,
        providerMetadata: finalStep.providerMetadata,
      },
    });
  } catch (error) {
    throw normalizeSdkError(error, signal);
  }
}

export function streamOpenAIResponses(input) {
  return streamProviderText({ ...input, provider: "openai" });
}

export function streamAnthropicChat(input) {
  return streamProviderText({ ...input, provider: "anthropic" });
}
