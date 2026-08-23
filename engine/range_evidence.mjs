const MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2],
  ['mar', 3], ['march', 3], ['apr', 4], ['april', 4],
  ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10], ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);
const CONTAINER_KEYS = new Set(['report', 'reportData', 'performance', 'range', 'period', 'dateRange', 'timeRange']);
const FROM_KEYS = ['from', 'start'];
const TO_KEYS = ['to', 'end'];

function isoDay(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function dateMatches(text) {
  const matches = [];
  const collect = (regex, convert) => {
    for (const match of text.matchAll(regex)) {
      const value = convert(match);
      if (value) matches.push({ index: match.index, end: match.index + match[0].length, value });
    }
  };
  collect(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g, m => isoDay(m[1], m[2], m[3]));
  collect(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g, m => isoDay(m[1], m[2], m[3]));
  collect(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2}),\s*(\d{4})\b/gi,
    m => isoDay(m[3], MONTHS.get(m[1].toLowerCase()), m[2]));
  matches.sort((a, b) => a.index - b.index || b.end - a.end);
  return matches.filter((match, index, all) => !all.slice(0, index).some(previous => match.index < previous.end));
}

function temporal(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = Math.abs(value) >= 1e11 ? value : value * 1000;
    const date = new Date(millis);
    if (!Number.isFinite(date.getTime())) return null;
    return { value: date.toISOString().replace('.000Z', 'Z'), precision: 'second' };
  }
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const day = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) {
    const valueDay = isoDay(day[1], day[2], day[3]);
    return valueDay ? { value: valueDay, precision: 'day' } : null;
  }
  const date = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(date.getTime())) return null;
  return { value: date.toISOString().replace('.000Z', 'Z'), precision: 'second' };
}

function normalizedPair(fromRaw, toRaw) {
  const from = temporal(fromRaw);
  const to = temporal(toRaw);
  if (!from || !to) return null;
  const precision = from.precision === 'second' || to.precision === 'second' ? 'second' : 'day';
  const promote = item => precision === 'second' && item.precision === 'day' ? `${item.value}T00:00:00Z` : item.value;
  const fromValue = promote(from);
  const toValue = promote(to);
  if (fromValue > toValue) return null;
  return { from: fromValue, to: toValue, precision };
}

export function parseRangeText(text) {
  if (typeof text !== 'string') return null;
  const matches = dateMatches(text);
  if (matches.length !== 2 || matches[0].value > matches[1].value) return null;
  return {
    from: matches[0].value,
    to: matches[1].value,
    source: 'strategy_tester',
    confidence: 'exact',
    precision: 'day',
  };
}

function findPair(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 3) return null;
  if (Array.isArray(node)) return node.length === 2 ? normalizedPair(node[0], node[1]) : null;

  const fromKey = FROM_KEYS.find(key => Object.hasOwn(node, key));
  const toKey = TO_KEYS.find(key => Object.hasOwn(node, key));
  if (fromKey && toKey) {
    const pair = normalizedPair(node[fromKey], node[toKey]);
    if (pair) return pair;
  }

  for (const key of CONTAINER_KEYS) {
    if (!Object.hasOwn(node, key)) continue;
    const pair = findPair(node[key], depth + 1);
    if (pair) return pair;
  }
  return null;
}

export function rangeFromAllowlistedReport(report) {
  const pair = findPair(report);
  return pair ? {
    ...pair,
    source: 'strategy_tester',
    confidence: 'exact',
  } : null;
}

export function rangeFromChartSeries(range) {
  const pair = normalizedPair(range?.from, range?.to);
  return pair ? {
    ...pair,
    source: 'chart_series',
    confidence: 'proxy',
  } : null;
}
