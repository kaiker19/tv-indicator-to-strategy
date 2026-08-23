const US_FEEDS = new Set(['AMEX', 'ARCA', 'BATS', 'NASDAQ', 'NYSE', 'NYSEARCA']);
const FEED_ALIASES = new Map([
  ['SSE', 'CN:SSE'],
  ['SSE_DLY', 'CN:SSE'],
  ['SZSE', 'CN:SZSE'],
  ['SZSE_DLY', 'CN:SZSE'],
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
  );
}

function stableKey(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  const splitAt = raw.lastIndexOf(':');
  if (splitAt < 0) return raw;
  const feed = raw.slice(0, splitAt);
  const ticker = raw.slice(splitAt + 1);
  if (!ticker) return raw;
  if (US_FEEDS.has(feed)) return `US:${ticker}`;
  const alias = FEED_ALIASES.get(feed);
  return alias ? `${alias}:${ticker}` : `${feed}:${ticker}`;
}

function normalizeRequestedRange(range) {
  if (!range || range.mode === 'full_history') return { mode: 'full_history' };
  const from = normalizeDate(range.from);
  const to = normalizeDate(range.to);
  return from && to ? { mode: 'explicit', from, to } : stableValue(range);
}

function normalizeDate(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z)?$/);
  if (!match) return null;
  const date = new Date(match[4] ? raw : `${raw}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return match[4] ? date.toISOString().replace('.000Z', 'Z') : raw;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeContext(context = {}) {
  const normalized = {
    symbol: normalizeSymbol(context.symbol),
    timeframe: String(context.timeframe || '').trim().toUpperCase() || null,
    costs: stableValue(context.costs || null),
    sourceDigest: context.sourceDigest || null,
    requestedRange: normalizeRequestedRange(context.requestedRange),
  };
  return { ...normalized, contextKey: stableKey(normalized) };
}

export function normalizeRange(range) {
  if (!range) return null;
  const from = normalizeDate(range.from);
  const to = normalizeDate(range.to);
  const source = String(range.source || '').trim();
  const confidence = range.confidence === 'exact' ? 'exact' : (range.confidence === 'proxy' ? 'proxy' : null);
  const precision = range.precision === 'second' ? 'second' : (range.precision === 'day' ? 'day' : null);
  if (!from || !to || !source || !confidence || !precision || from > to) return null;
  return { from, to, source, confidence, precision };
}

function normalizedRuns(runs) {
  return (runs || []).map((item) => {
    const context = normalizeContext(item.context);
    const range = normalizeRange(item.range);
    return {
      context,
      range,
      rangeKey: range ? stableKey(range) : null,
      bhPct: finiteNumber(item.bhPct),
      benchmarkSource: String(item.benchmarkSource || '').trim() || null,
    };
  });
}

function objectiveFields(requestedObjective, safeForAlpha) {
  const requested = requestedObjective || 'risk_adjusted';
  if (requested !== 'alpha') {
    return { requestedObjective: requested, effectiveObjective: requested, nextAction: 'keep_objective' };
  }
  if (safeForAlpha === 'single') {
    return { requestedObjective: requested, effectiveObjective: 'alpha', nextAction: 'report_same_run' };
  }
  if (safeForAlpha) {
    return { requestedObjective: requested, effectiveObjective: 'alpha', nextAction: 'rank_alpha' };
  }
  return { requestedObjective: requested, effectiveObjective: 'risk_adjusted', nextAction: 'rank_without_alpha' };
}

function result(status, reason, normalized, requestedObjective, requestedRange, safeForAlpha = false) {
  return {
    comparisonStatus: status,
    reason,
    requestedRange: normalizeRequestedRange(requestedRange),
    observedRanges: normalized.map(run => run.range).filter(Boolean),
    ...objectiveFields(requestedObjective, safeForAlpha),
  };
}

export function classifyEvaluation({ runs = [], requestedObjective = 'risk_adjusted', requestedRange = null } = {}) {
  const normalized = normalizedRuns(runs);
  if (!normalized.length) {
    return result('unverified', 'range_unavailable', normalized, requestedObjective, requestedRange);
  }

  const benchmarkMissing = normalized.some(run => run.bhPct == null || !run.benchmarkSource);
  if (normalized.length === 1) {
    return benchmarkMissing
      ? result('unverified', 'benchmark_missing', normalized, requestedObjective, requestedRange)
      : result('single_run', 'single_run', normalized, requestedObjective, requestedRange, 'single');
  }

  if (new Set(normalized.map(run => run.context.contextKey)).size !== 1) {
    return result('incompatible', 'context_mismatch', normalized, requestedObjective, requestedRange);
  }
  if (benchmarkMissing) {
    return result('unverified', 'benchmark_missing', normalized, requestedObjective, requestedRange);
  }
  if (new Set(normalized.map(run => run.benchmarkSource)).size !== 1) {
    return result('unverified', 'benchmark_missing', normalized, requestedObjective, requestedRange);
  }
  if (normalized.some(run => !run.range || run.range.confidence !== 'exact')) {
    return result('unverified', 'range_unavailable', normalized, requestedObjective, requestedRange);
  }
  if (new Set(normalized.map(run => run.rangeKey)).size !== 1) {
    return result('incompatible', 'range_mismatch', normalized, requestedObjective, requestedRange);
  }

  const referenceBh = normalized[0].bhPct;
  const tolerance = Math.max(0.02, Math.abs(referenceBh) * 0.00001);
  if (normalized.some(run => Math.abs(run.bhPct - referenceBh) > tolerance)) {
    return result('incompatible', 'benchmark_value_drift', normalized, requestedObjective, requestedRange);
  }

  return result('comparable', 'comparable', normalized, requestedObjective, requestedRange, true);
}

export function compactEvaluation(evaluation = {}) {
  const seen = new Set();
  const observedRanges = [];
  for (const candidate of evaluation.observedRanges || []) {
    const range = normalizeRange(candidate);
    if (!range) continue;
    const compact = { from: range.from, to: range.to, source: range.source, precision: range.precision };
    const key = stableKey(compact);
    if (seen.has(key)) continue;
    seen.add(key);
    observedRanges.push(compact);
    if (observedRanges.length === 3) break;
  }
  return {
    comparisonStatus: evaluation.comparisonStatus || 'unverified',
    reason: evaluation.reason || 'range_unavailable',
    requestedRange: normalizeRequestedRange(evaluation.requestedRange),
    observedRanges,
    requestedObjective: evaluation.requestedObjective || 'risk_adjusted',
    effectiveObjective: evaluation.effectiveObjective || 'risk_adjusted',
    nextAction: evaluation.nextAction || 'keep_objective',
  };
}
