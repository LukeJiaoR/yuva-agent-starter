function nonNegativeInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  const integer = Math.floor(parsed);
  return Number.isFinite(parsed)
    && parsed >= 0
    && Number.isSafeInteger(integer)
    && integer <= 2_147_483_647
    ? integer
    : null;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 9_999_999_999
    ? parsed
    : null;
}

function boundedString(value, maxLength) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).slice(0, maxLength);
}

function currencyCode(value) {
  const currency = boundedString(value, 8)?.toUpperCase() || null;
  return currency && /^[A-Z]{3,8}$/u.test(currency) ? currency : null;
}

function findNestedKey(obj, targetKey) {
  if (!obj || typeof obj !== "object") return undefined;
  if (obj[targetKey] !== undefined) return obj[targetKey];
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      const found = findNestedKey(val, targetKey);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function missingProviderUsage() {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    toolTokens: null,
    providerCost: null,
    providerSurcharge: null,
    currency: null,
    source: "missing",
  };
}

export function normalizedSdkUsage(usage) {
  const raw = usage?.raw && typeof usage.raw === "object" ? usage.raw : {};
  const values = {
    inputTokens: nonNegativeInteger(usage?.inputTokens),
    outputTokens: nonNegativeInteger(usage?.outputTokens),
    totalTokens: nonNegativeInteger(usage?.totalTokens),
    cachedInputTokens: nonNegativeInteger(usage?.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: nonNegativeInteger(usage?.inputTokenDetails?.cacheWriteTokens),
    reasoningTokens: nonNegativeInteger(usage?.outputTokenDetails?.reasoningTokens),
    toolTokens: nonNegativeInteger(raw.tool_tokens),
    providerCost: nonNegativeNumber(raw.cost),
    providerSurcharge: nonNegativeNumber(raw.surcharge),
    currency: currencyCode(raw.currency),
  };
  const hasUsage = Object.values(values).some((value) => value !== null);
  return hasUsage ? { ...values, source: "provider" } : missingProviderUsage();
}

/**
 * Normalizes SDK provider responses into a standard schema.
 * Allows custom safety checks and metadata extraction via options or nested providerMetadata discovery.
 */
export function normalizeSdkProviderResult(
  data = {},
  {
    provider,
    model,
    isSafetyRefusal = (d) => d.finishReason === "content-filter"
      || findNestedKey(d.providerMetadata, "safetyRefusal") === true,
    extractRequestId = (d) => findNestedKey(d.providerMetadata, "providerRequestId") || d.response?.id,
  } = {},
) {
  const finishReason = boundedString(data.finishReason, 80);
  const safetyRefusal = typeof isSafetyRefusal === "function"
    ? isSafetyRefusal(data)
    : finishReason === "content-filter";
  const requestId = typeof extractRequestId === "function"
    ? extractRequestId(data)
    : data.response?.id;

  return {
    text: String(data.text || ""),
    provider: boundedString(provider, 80),
    model: boundedString(data.response?.modelId || model, 160),
    requestId: boundedString(requestId, 255),
    finishReason,
    outcome: safetyRefusal
      ? "safety_refusal"
      : finishReason === "error"
        ? "provider_error"
        : "success",
    usage: normalizedSdkUsage(data.usage),
  };
}

export function createSyntheticProviderResult({
  text = "",
  provider = "synthetic",
  model = "synthetic-v1",
  requestId = "synthetic-run",
  finishReason = "stop",
  outcome = "success",
  usage = null,
} = {}) {
  const outputTokens = Math.max(1, String(text || "").trim().split(/\s+/u).filter(Boolean).length);
  return {
    text: String(text || ""),
    provider,
    model,
    requestId,
    finishReason,
    outcome,
    usage: usage || {
      inputTokens: 0,
      outputTokens,
      totalTokens: outputTokens,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      toolTokens: 0,
      providerCost: 0,
      providerSurcharge: 0,
      currency: "USD",
      source: "synthetic",
    },
  };
}

export function providerText(result) {
  return typeof result === "string" ? result : String(result?.text || "");
}
