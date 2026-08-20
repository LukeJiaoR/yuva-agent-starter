const TOKEN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[\p{Extended_Pictographic}\p{P}\p{S}]/gu;

/**
 * Normalizes text for AI tokenization and prompt evaluation (NFC unicode normalization, standard newlines).
 */
export function normalizeText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .trim();
}

/**
 * Counts unicode token units across multilingual text (Han, Latin, CJK, Emojis, Punctuation).
 */
export function countUnicodeTokens(text) {
  const normalized = normalizeText(text);
  if (!normalized) return 0;
  return Array.from(normalized.matchAll(TOKEN_PATTERN)).length;
}

export const countTextUnits = countUnicodeTokens;
export const normalizeAskText = normalizeText;
export const countAskTokens = countUnicodeTokens;
