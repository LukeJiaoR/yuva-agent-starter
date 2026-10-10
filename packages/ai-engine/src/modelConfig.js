import { usesProviderDefaultOutputTokens } from './outputTokenPolicy.js';

export const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

export function resolveOpenAIChatModel(env = process.env) {
  return String(env.OPENAI_CHAT_MODEL || "").trim();
}

export function resolveOpenAIBaseUrl(env = process.env) {
  return String(env.OPENAI_BASE_URL || "").trim();
}

export function resolveOpenAIApiKey(env = process.env) {
  return String(env.OPENAI_API_KEY || "").trim();
}

export function resolveAnthropicApiKey(env = process.env) {
  return String(env.ANTHROPIC_API_KEY || "").trim();
}

export function resolveReasoningEffort(env = process.env, key = "REASONING_EFFORT", fallback = "medium") {
  const configured = String(env[key] || "").trim();
  const resolved = configured || fallback;
  if (!REASONING_EFFORTS.has(resolved)) {
    throw new Error(`${key} must be one of: ${[...REASONING_EFFORTS].join(", ")}`);
  }
  return resolved;
}

export function assertReasoningEffort(value, label = "reasoningEffort") {
  if (value !== undefined && value !== null && !REASONING_EFFORTS.has(value)) {
    throw new Error(`${label} must be one of: ${[...REASONING_EFFORTS].join(", ")}`);
  }
  return value;
}

export function resolveMaxOutputTokens(options = {}) {
  if (usesProviderDefaultOutputTokens(options)) return undefined;
  const defaultMaxTokens = Number.parseInt(options.maxOutputTokensDefault, 10) || 1024;
  const requestedMaxTokens = Number.parseInt(options.maxOutputTokens, 10) || defaultMaxTokens;
  const maxOutputTokensCap = Number.parseInt(options.maxOutputTokensCap, 10);
  return maxOutputTokensCap
    ? Math.min(requestedMaxTokens, maxOutputTokensCap)
    : requestedMaxTokens;
}
