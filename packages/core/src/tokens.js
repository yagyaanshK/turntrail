export const TOKEN_ESTIMATOR = 'utf8-bytes-v1';

// A deterministic, dependency-free estimate for planning handoff size. Three
// UTF-8 bytes per token is intentionally conservative for English prose and
// source code, while remaining useful for multibyte scripts. It is not a model
// tokenizer and callers must present it as an estimate.
export function estimateTextTokens(value) {
  const text = String(value || '');
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}
