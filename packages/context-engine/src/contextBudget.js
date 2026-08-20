export const DEFAULT_CONTEXT_BUDGET_TOKENS = 6_000;
export const DEFAULT_CONTEXT_MIN_BUDGET_TOKENS = 4_096;
export const DEFAULT_CONTEXT_MAX_BUDGET_TOKENS = 12_000;

export const DEFAULT_CONTEXT_PRIORITIES = Object.freeze({
  safety: 1_000,
  question: 990,
  output_contract: 980,
  system: 900,
  knowledge: 800,
  summary: 500,
  memory: 400,
  history: 200,
});

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function defaultTokenCounter(text) {
  if (!text) return 0;
  return String(text).trim().split(/\s+/u).filter(Boolean).length;
}

function normalizedUnit(unit, order, priorities, tokenCounter) {
  const text = typeof unit?.text === "string" ? unit.text : "";
  const category = typeof unit?.category === "string" && unit.category
    ? unit.category
    : String(unit?.key || "context").split(/[.:]/u)[0];
  return {
    ...unit,
    key: String(unit?.key || `context.${order}`),
    category,
    channel: unit?.channel === "message" ? "message" : "system",
    priority: Number.isFinite(Number(unit?.priority))
      ? Number(unit.priority)
      : Number(priorities[category] || 0),
    required: unit?.required === true,
    text,
    order,
    requestedTokens: typeof tokenCounter === "function" ? tokenCounter(text) : defaultTokenCounter(text),
  };
}

function diagnostic(unit, reason, includedTokens = 0) {
  return {
    key: unit.key,
    category: unit.category,
    channel: unit.channel,
    reason,
    requested_tokens: unit.requestedTokens,
    included_tokens: includedTokens,
    omitted_tokens: Math.max(0, unit.requestedTokens - includedTokens),
  };
}

export function resolveContextBudget(env = process.env, {
  envKey = "CONTEXT_BUDGET_TOKENS",
  defaultBudget = DEFAULT_CONTEXT_BUDGET_TOKENS,
  minBudget = DEFAULT_CONTEXT_MIN_BUDGET_TOKENS,
  maxBudget = DEFAULT_CONTEXT_MAX_BUDGET_TOKENS,
} = {}) {
  const configured = integer(env?.[envKey]);
  if (configured < minBudget) return defaultBudget;
  return Math.min(configured, maxBudget);
}

/**
 * Generic priority-based context budget allocator with channel separation and token diagnostics.
 */
export function allocateContextBudget({
  units = [],
  budgetTokens = DEFAULT_CONTEXT_BUDGET_TOKENS,
  priorities = DEFAULT_CONTEXT_PRIORITIES,
  tokenCounter = defaultTokenCounter,
} = {}) {
  const budget = Math.max(1, integer(budgetTokens) || DEFAULT_CONTEXT_BUDGET_TOKENS);
  const normalized = (Array.isArray(units) ? units : []).map((unit, order) =>
    normalizedUnit(unit, order, priorities, tokenCounter)
  );
  const required = normalized
    .filter((unit) => unit.required)
    .sort((left, right) => right.priority - left.priority || left.order - right.order);
  const optional = normalized
    .filter((unit) => !unit.required)
    .sort((left, right) => right.priority - left.priority || left.order - right.order);
  const selected = new Map();
  const omitted = [];
  let usedTokens = 0;

  for (const unit of required) {
    if (usedTokens + unit.requestedTokens > budget) {
      throw new RangeError("Required context units exceed the configured budget");
    }
    selected.set(unit.order, unit);
    usedTokens += unit.requestedTokens;
  }

  for (const unit of optional) {
    const remaining = budget - usedTokens;
    if (unit.requestedTokens <= remaining) {
      selected.set(unit.order, unit);
      usedTokens += unit.requestedTokens;
      continue;
    }
    omitted.push(diagnostic(unit, "budget_exhausted"));
  }

  const selectedUnits = [...selected.values()].sort((left, right) => left.order - right.order);
  const included = selectedUnits.map((unit) => diagnostic(unit, "included", unit.requestedTokens));
  const requestedTokens = normalized.reduce((total, unit) => total + unit.requestedTokens, 0);
  return {
    systemUnits: selectedUnits.filter((unit) => unit.channel === "system"),
    messageUnits: selectedUnits.filter((unit) => unit.channel === "message"),
    diagnostics: {
      budget_tokens: budget,
      requested_tokens: requestedTokens,
      included_tokens: usedTokens,
      omitted_tokens: requestedTokens - usedTokens,
      used_tokens: usedTokens,
      remaining_tokens: budget - usedTokens,
      included,
      omitted,
    },
    usedTokens,
    budgetTokens: budget,
  };
}

export const planContextBudget = allocateContextBudget;
