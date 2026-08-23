import { classicStrategies } from "./classic.mjs";

export function matchStrategy(indicatorText, options = {}) {
  const limit = options.limit ?? 3;
  const text = String(indicatorText ?? "");
  const lower = text.toLowerCase();
  if (!lower.trim()) return [];

  return classicStrategies
    .map((entry) => ({ entry, score: scoreEntry(entry, text, lower) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map(({ entry, score }) => ({ ...entry, score }));
}

function scoreEntry(entry, text, lower) {
  let score = 0;
  for (const fn of entry.features?.functions ?? []) {
    if (lower.includes(fn.toLowerCase())) score += 3;
  }
  for (const keyword of entry.features?.keywords ?? []) {
    if (lower.includes(keyword.toLowerCase())) score += 1;
  }
  for (const pattern of entry.features?.regex ?? []) {
    if (new RegExp(pattern, "i").test(text)) score += 2;
  }
  return score;
}
