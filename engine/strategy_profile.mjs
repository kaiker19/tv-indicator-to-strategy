import { basename, dirname, isAbsolute, relative } from 'path';
import { parseNum, parsePct } from './scan_summary.mjs';

export const PROFILE_FAMILIES = Object.freeze([
  'trend',
  'mean_reversion',
  'breakout',
  'state_switching',
  'other',
]);

export const PROFILE_PARAMETER_POLICIES = Object.freeze([
  'symbol_specific',
  'fixed_cross_market',
]);

export const PROFILE_VERDICT_LABELS = Object.freeze([
  'symbol_specific',
  'cross_market',
  'prefer_bh',
  'unverified',
]);

const FLAG_REASONS = Object.freeze({
  benchmark_missing: '最终完整回测缺少同次 B&H，无法判断超额收益。',
  benchmark_value_drift: '候选区间一致，但 B&H 数值漂移。',
  context_mismatch: '候选市场或周期上下文不一致。',
  cross_market_failed: '相同参数没有通过全部多市场验证。',
  exact_range_missing: '缺少唯一的 Strategy Tester 精确区间证据。',
  extreme_pf_low_sample: '低样本下 PF 异常偏高。',
  fixed_parameter_evidence_missing: '缺少跨市场固定参数与源码摘要证据。',
  isolated_peak: '最优参数是孤立峰值，邻域稳定性不足。',
  low_sample: '最终完整回测少于 10 笔交易。',
  negative_alpha_market: '至少一个验证市场落后 B&H。',
  non_positive_alpha: '在当前评估合同下没有跑赢 B&H。',
  range_mismatch: '候选有效回测区间不一致。',
  range_unavailable: '有效回测区间未得到证明。',
  stability_unverified: '缺少参数高原或显式相邻参数复核。',
});

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function sameObject(a, b) {
  return JSON.stringify(stableObject(a)) === JSON.stringify(stableObject(b));
}

function finiteOrNull(value, { percentage = false } = {}) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = percentage ? parsePct(value) : parseNum(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value) {
  return value == null ? null : Math.round(value * 100) / 100;
}

function normalizeTimeframe(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  if (/^\d+[DWM]$/.test(raw)) return raw;
  if (raw === 'D' || raw === 'W' || raw === 'M') return `1${raw}`;
  return raw;
}

function idPart(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function ticker(value) {
  return String(value || '').split(':').pop().replace(/^.*_DLY:/, '');
}

function symbolsMatch(a, b) {
  return a === b || (ticker(a) && ticker(a) === ticker(b));
}

function findPrimaryRun(summary) {
  const runs = Array.isArray(summary.runs) ? summary.runs : [];
  const actual = summary.strategy?.actualSymbol || summary.proof?.actual?.symbol;
  const requested = summary.strategy?.requestedSymbol;
  return runs.find(run => symbolsMatch(run?.meta?.symbol, actual))
    || runs.find(run => symbolsMatch(run?.meta?.label, requested))
    || (runs.length === 1 ? runs[0] : null);
}

function uniqueExactRange(evaluation) {
  const rows = (evaluation?.observedRanges || []).filter(range => (
    range?.from
    && range?.to
    && range?.source === 'strategy_tester'
    && range?.precision === 'day'
  ));
  const unique = [...new Map(rows.map(range => [`${range.from}|${range.to}|${range.source}|${range.precision}`, range])).values()];
  return unique.length === 1 ? { ...unique[0] } : null;
}

function relativeArtifact(path, summaryPath) {
  if (!path || !summaryPath || !isAbsolute(path) || !isAbsolute(summaryPath)) return path || null;
  const rel = relative(dirname(summaryPath), path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

function normalizePerformance(run) {
  const metrics = run?.metrics || {};
  const strategyPct = finiteOrNull(metrics.total_pnl, { percentage: true });
  const buyHoldPct = finiteOrNull(metrics.buy_hold_return, { percentage: true });
  return {
    strategyPct,
    buyHoldPct,
    alphaPct: strategyPct != null && buyHoldPct != null ? round2(strategyPct - buyHoldPct) : null,
    maxDrawdownPct: finiteOrNull(metrics.max_drawdown, { percentage: true }),
    profitFactor: finiteOrNull(metrics.profit_factor),
    trades: finiteOrNull(metrics.total_trades),
    winPct: finiteOrNull(metrics.percent_profitable ?? metrics.win_pct, { percentage: true }),
  };
}

function normalizeValidation(summaryValidation, policy) {
  const sourceRows = Array.isArray(summaryValidation?.rows) ? summaryValidation.rows : [];
  const rows = sourceRows.map(row => ({
    symbol: row.symbol || null,
    strategyPct: finiteOrNull(row.strategy ?? row.strategy_pct, { percentage: typeof (row.strategy ?? row.strategy_pct) === 'string' }),
    buyHoldPct: finiteOrNull(row.bh ?? row.bh_pct, { percentage: typeof (row.bh ?? row.bh_pct) === 'string' }),
    alphaPct: finiteOrNull(row.alpha ?? row.alpha_pct, { percentage: typeof (row.alpha ?? row.alpha_pct) === 'string' }),
    trades: finiteOrNull(row.trades ?? row.total_trades),
    profitFactor: finiteOrNull(row.pf ?? row.profit_factor),
    beatBh: typeof row.beatBh === 'boolean' ? row.beatBh : finiteOrNull(row.alpha ?? row.alpha_pct) > 0,
    benchmarkSource: row.benchmarkSource ?? row.benchmark_source ?? null,
    error: row.error ?? null,
  }));
  return {
    kind: summaryValidation?.kind || (rows.length ? 'multi_symbol' : null),
    parameterPolicy: summaryValidation?.parameterPolicy || policy,
    beatBh: summaryValidation?.beatBh || `${rows.filter(row => row.alphaPct != null && row.alphaPct > 0).length} / ${rows.length}`,
    failedMarkets: rows.filter(row => row.error || row.alphaPct == null || row.alphaPct <= 0).map(row => row.symbol).filter(Boolean),
    rows,
  };
}

function verdict(label, flags = []) {
  const unique = [...new Set(flags)];
  return {
    label,
    quality: label === 'unverified' ? 'insufficient' : 'qualified',
    reasons: unique.map(flag => FLAG_REASONS[flag] || flag),
    flags: unique,
  };
}

function neighborhoodEvidence({
  neighborhood,
  selectedParams,
  actualSymbol,
  timeframe,
  costs,
  range,
  selectedSourceSha256,
} = {}) {
  if (!neighborhood) return { value: null, errors: [] };
  const errors = [];
  const axis = neighborhood.axis;
  const points = Array.isArray(neighborhood.points) ? neighborhood.points : [];
  const selectedValue = Number(selectedParams?.[axis]);
  if (neighborhood.verified !== true) errors.push('neighborhood.verified must be true');
  if (!axis || !Object.prototype.hasOwnProperty.call(selectedParams || {}, axis) || !Number.isFinite(selectedValue)) {
    errors.push('neighborhood.axis must name a numeric selected parameter');
  }
  if (points.length < 2) errors.push('neighborhood.points requires at least two runs');

  const normalized = points.map((point, index) => {
    const prefix = `neighborhood.points[${index}]`;
    const params = point?.params && typeof point.params === 'object' ? stableObject(point.params) : null;
    const paramKeys = [...new Set([...Object.keys(selectedParams || {}), ...Object.keys(params || {})])];
    const changed = paramKeys.filter(key => !sameObject(selectedParams?.[key], params?.[key]));
    const pointValue = Number(params?.[axis]);
    if (!params || changed.length !== 1 || changed[0] !== axis || !Number.isFinite(pointValue)) {
      errors.push(`${prefix}.params must change only neighborhood.axis`);
    }
    if (!symbolsMatch(point?.symbol, actualSymbol)) errors.push(`${prefix}.symbol must match the selected run`);
    if (normalizeTimeframe(point?.timeframe) !== timeframe) errors.push(`${prefix}.timeframe must match the selected run`);
    if (!sameObject(point?.costs, costs)) errors.push(`${prefix}.costs must match the selected run`);
    if (!range || !sameObject(point?.range, range)) errors.push(`${prefix}.range must match the exact selected range`);

    for (const key of ['strategyPct', 'buyHoldPct', 'alphaPct', 'maxDrawdownPct', 'profitFactor', 'trades']) {
      if (typeof point?.[key] !== 'number' || !Number.isFinite(point[key])) errors.push(`${prefix}.${key} must be finite`);
    }
    if (Number(point?.alphaPct) <= 0) errors.push(`${prefix}.alphaPct must be positive`);
    if (Number(point?.trades) < 10) errors.push(`${prefix}.trades must be at least 10`);
    if (Number.isFinite(point?.strategyPct) && Number.isFinite(point?.buyHoldPct) && Number.isFinite(point?.alphaPct)
      && Math.abs((point.strategyPct - point.buyHoldPct) - point.alphaPct) > 0.05) {
      errors.push(`${prefix}.alphaPct must equal strategyPct - buyHoldPct`);
    }
    if (!/^[a-f0-9]{64}$/i.test(String(point?.runSummarySha256 || ''))) errors.push(`${prefix}.runSummarySha256 must be SHA-256`);
    if (!/^[a-f0-9]{64}$/i.test(String(point?.sourceSha256 || ''))) errors.push(`${prefix}.sourceSha256 must be SHA-256`);
    if (!['same_source', 'input_default_only'].includes(point?.sourceRelation)) {
      errors.push(`${prefix}.sourceRelation must be same_source or input_default_only`);
    } else if (point.sourceRelation === 'same_source' && point.sourceSha256 !== selectedSourceSha256) {
      errors.push(`${prefix}.sourceSha256 must match the selected source for same_source evidence`);
    } else if (point.sourceRelation === 'input_default_only' && point.changedInput !== axis) {
      errors.push(`${prefix}.changedInput must match neighborhood.axis`);
    }

    return {
      params,
      symbol: point?.symbol || null,
      timeframe: normalizeTimeframe(point?.timeframe),
      costs: point?.costs ? stableObject(point.costs) : null,
      range: point?.range ? stableObject(point.range) : null,
      strategyPct: point?.strategyPct ?? null,
      buyHoldPct: point?.buyHoldPct ?? null,
      alphaPct: point?.alphaPct ?? null,
      maxDrawdownPct: point?.maxDrawdownPct ?? null,
      profitFactor: point?.profitFactor ?? null,
      trades: point?.trades ?? null,
      runSummarySha256: String(point?.runSummarySha256 || '').toLowerCase(),
      sourceSha256: String(point?.sourceSha256 || '').toLowerCase(),
      sourceRelation: point?.sourceRelation || null,
      changedInput: point?.changedInput || null,
    };
  });

  const paramKeys = normalized.map(point => JSON.stringify(point.params));
  if (new Set(paramKeys).size !== paramKeys.length) errors.push('neighborhood.points params must be distinct');
  const values = normalized.map(point => Number(point.params?.[axis])).filter(Number.isFinite);
  if (Number.isFinite(selectedValue) && !(values.some(value => value < selectedValue) && values.some(value => value > selectedValue))) {
    errors.push('neighborhood.points must bracket the selected parameter');
  }
  if (errors.length) return { value: null, errors: [...new Set(errors)] };
  normalized.sort((a, b) => Number(a.params[axis]) - Number(b.params[axis]));
  return { value: { verified: true, axis, points: normalized }, errors: [] };
}

function evidenceFlags(summary, performance, range) {
  const flags = [];
  const status = summary.evaluation?.comparisonStatus;
  if (!['comparable', 'single_run'].includes(status)) {
    flags.push(summary.evaluation?.reason || 'range_unavailable');
  }
  if (!range) flags.push('exact_range_missing');
  if (performance.strategyPct == null || performance.buyHoldPct == null || performance.alphaPct == null) {
    flags.push('benchmark_missing');
  }
  if (performance.trades == null || performance.trades < 10) flags.push('low_sample');
  if (performance.profitFactor != null && performance.profitFactor >= 20 && (performance.trades == null || performance.trades < 10)) {
    flags.push('extreme_pf_low_sample');
  }
  return flags;
}

function fixedValidationPasses(summary, metadata, sourceSha256, validation) {
  const raw = summary.validation || {};
  const identityMatches = raw.parameterPolicy === 'fixed_cross_market'
    && sameObject(raw.params, metadata.selectedParams)
    && raw.sourceSha256 === sourceSha256;
  const trustworthy = validation.rows.length >= 2
    && validation.rows.every(row => (
      !row.error
      && row.benchmarkSource
      && row.alphaPct != null
      && row.alphaPct > 0
      && row.trades != null
      && row.trades >= 10
    ));
  return { identityMatches, trustworthy };
}

export function validateProfileInput({ summary, metadata, sourceSha256 } = {}) {
  const errors = [];
  const warnings = [];
  if (!summary || typeof summary !== 'object') errors.push('summary must be an object');
  if (summary?.schemaVersion !== 2) errors.push('summary.schemaVersion must be 2');
  if (summary?.status !== 'complete') errors.push('summary.status must be complete');
  if (summary?.proof?.ok !== true) errors.push('summary.proof.ok must be true');
  if (!summary?.strategy?.scriptName) errors.push('summary.strategy.scriptName is required');
  if (!(summary?.strategy?.actualSymbol || summary?.strategy?.requestedSymbol || summary?.proof?.actual?.symbol)) {
    errors.push('summary.strategy symbol is required');
  }
  if (!summary?.strategy?.timeframe) errors.push('summary.strategy.timeframe is required');
  if (!summary?.strategy?.costs) errors.push('summary.strategy.costs is required');
  if (!Array.isArray(summary?.runs) || !summary.runs.length) errors.push('summary.runs requires at least one completed run');
  if (!summary?.evaluation || typeof summary.evaluation !== 'object') errors.push('summary.evaluation is required');
  if (!metadata?.strategyId) errors.push('metadata.strategyId is required');
  if (!PROFILE_FAMILIES.includes(metadata?.family)) errors.push(`metadata.family must be one of ${PROFILE_FAMILIES.join(', ')}`);
  if (!metadata?.thesis) errors.push('metadata.thesis is required');
  if (!PROFILE_PARAMETER_POLICIES.includes(metadata?.parameterPolicy)) {
    errors.push(`metadata.parameterPolicy must be one of ${PROFILE_PARAMETER_POLICIES.join(', ')}`);
  }
  if (!metadata?.selectedParams || typeof metadata.selectedParams !== 'object') {
    errors.push('metadata.selectedParams is required');
  } else if (!sameObject(metadata.selectedParams, summary?.proof?.actual?.params)) {
    errors.push('metadata.selectedParams must match summary.proof.actual.params');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(sourceSha256 || ''))) errors.push('sourceSha256 must be a SHA-256 hex digest');
  if (summary?.proof?.actual?.strategyName && summary?.proof?.actual?.strategyName !== summary?.strategy?.scriptName) {
    errors.push('proof strategyName must match summary.strategy.scriptName');
  }
  if (!summary?.optimization) warnings.push('optimization evidence is missing');
  if (!summary?.validation) warnings.push('cross-market validation is missing');
  return { errors, warnings };
}

export function buildStrategyProfile({ summary, metadata, sourceSha256, summaryPath = null, createdAt = null } = {}) {
  const validationResult = validateProfileInput({ summary, metadata, sourceSha256 });
  if (validationResult.errors.length) throw new Error(validationResult.errors.join('; '));

  const actualSymbol = summary.strategy.actualSymbol || summary.proof.actual.symbol || summary.strategy.requestedSymbol;
  const timeframe = normalizeTimeframe(summary.strategy.timeframe);
  const range = uniqueExactRange(summary.evaluation);
  const primaryRun = findPrimaryRun(summary);
  if (!primaryRun) throw new Error('summary.runs does not contain the proven primary symbol');
  const performance = normalizePerformance(primaryRun);
  const normalizedValidation = normalizeValidation(summary.validation, metadata.parameterPolicy);
  const flags = evidenceFlags(summary, performance, range);
  const neighborhood = neighborhoodEvidence({
    neighborhood: metadata.neighborhood,
    selectedParams: metadata.selectedParams,
    actualSymbol,
    timeframe,
    costs: summary.strategy.costs,
    range,
    selectedSourceSha256: sourceSha256.toLowerCase(),
  });
  const stable = summary.optimization?.shape?.type === 'plateau' || neighborhood.value != null;
  const shapeType = summary.optimization?.shape?.type || null;
  if (performance.alphaPct != null && performance.alphaPct > 0 && !stable) {
    flags.push(shapeType === 'isolated_peak' ? 'isolated_peak' : 'stability_unverified');
  }

  let profileVerdict;
  if (flags.length) {
    profileVerdict = verdict('unverified', flags);
  } else if (performance.alphaPct <= 0) {
    profileVerdict = verdict('prefer_bh', ['non_positive_alpha']);
  } else if (metadata.parameterPolicy === 'fixed_cross_market') {
    const fixed = fixedValidationPasses(summary, metadata, sourceSha256, normalizedValidation);
    if (!fixed.identityMatches) profileVerdict = verdict('unverified', ['fixed_parameter_evidence_missing']);
    else if (fixed.trustworthy) profileVerdict = verdict('cross_market');
    else profileVerdict = verdict('symbol_specific', ['cross_market_failed']);
  } else {
    const validationFlags = normalizedValidation.failedMarkets.length ? ['cross_market_failed'] : [];
    profileVerdict = verdict('symbol_specific', validationFlags);
  }

  const artifacts = summary.artifacts || {};
  return {
    schemaVersion: 1,
    profileId: `${idPart(metadata.strategyId)}__${idPart(actualSymbol)}__${idPart(timeframe)}`,
    createdAt: createdAt || new Date().toISOString(),
    strategy: {
      id: metadata.strategyId,
      name: summary.strategy.scriptName,
      family: metadata.family,
      thesis: metadata.thesis,
      sourceSha256: sourceSha256.toLowerCase(),
      sourcePath: relativeArtifact(summary.source?.path, summaryPath),
    },
    scope: {
      parameterPolicy: metadata.parameterPolicy,
      requestedSymbol: summary.strategy.requestedSymbol || null,
      actualSymbol,
      timeframe,
      costs: { ...summary.strategy.costs },
      range,
    },
    selection: {
      params: stableObject(metadata.selectedParams),
      objective: summary.optimization?.effectiveObjective || summary.evaluation?.effectiveObjective || null,
      shape: summary.optimization?.shape ? { ...summary.optimization.shape } : null,
      axes: Array.isArray(summary.optimization?.axes) ? summary.optimization.axes.map(axis => ({ ...axis })) : [],
      budget: finiteOrNull(summary.optimization?.budget),
      evaluated: finiteOrNull(summary.optimization?.evaluated),
      neighborhood: neighborhood.value,
    },
    performance,
    validation: normalizedValidation,
    verdict: profileVerdict,
    artifacts: {
      runSummary: relativeArtifact(summaryPath, summaryPath),
      proofScreenshot: relativeArtifact(artifacts.proofScreenshot, summaryPath),
      heatmap: relativeArtifact(artifacts.heatmap, summaryPath),
      optimization: relativeArtifact(artifacts.optimization, summaryPath),
    },
    promotion: { status: 'runtime_only' },
  };
}

function isFiniteOrNull(value) {
  return value == null || (typeof value === 'number' && Number.isFinite(value));
}

function isAbsoluteLike(value) {
  return typeof value === 'string' && (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value));
}

function containsPineSource(value) {
  return typeof value === 'string' && (
    value.includes('//@version')
    || /(?:^|\n)\s*(?:strategy|indicator)\s*\(/i.test(value)
  );
}

function isSecretLikeKey(key) {
  return /secret|cookie|webhook|token|authorization|alert.?message/i.test(String(key));
}

function inspectPromotedValue(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectPromotedValue(item, `${path}[${index}]`, errors));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const child = path ? `${path}.${key}` : key;
      if (isSecretLikeKey(key)) errors.push(`${child} contains a secret-like key`);
      inspectPromotedValue(item, child, errors);
    }
    return;
  }
  if (isAbsoluteLike(value)) errors.push(`${path} contains an absolute path`);
  if (containsPineSource(value)) errors.push(`${path} contains embedded Pine source`);
}

export function validateStrategyProfile(profile, { mode = 'runtime' } = {}) {
  const errors = [];
  const warnings = [];
  if (!['runtime', 'promoted'].includes(mode)) errors.push('mode must be runtime or promoted');
  if (!profile || typeof profile !== 'object') return { errors: ['profile must be an object'], warnings };
  if (profile.schemaVersion !== 1) errors.push('profile.schemaVersion must be 1');
  if (!profile.profileId) errors.push('profile.profileId is required');
  if (!profile.createdAt || !Number.isFinite(Date.parse(profile.createdAt))) errors.push('profile.createdAt must be an ISO date');
  if (!profile.strategy?.id) errors.push('profile.strategy.id is required');
  if (!profile.strategy?.name) errors.push('profile.strategy.name is required');
  if (!PROFILE_FAMILIES.includes(profile.strategy?.family)) {
    errors.push(`profile.strategy.family must be one of ${PROFILE_FAMILIES.join(', ')}`);
  }
  if (!profile.strategy?.thesis) errors.push('profile.strategy.thesis is required');
  if (!/^[a-f0-9]{64}$/i.test(String(profile.strategy?.sourceSha256 || ''))) {
    errors.push('profile.strategy.sourceSha256 must be a SHA-256 hex digest');
  }
  if (!PROFILE_PARAMETER_POLICIES.includes(profile.scope?.parameterPolicy)) {
    errors.push(`profile.scope.parameterPolicy must be one of ${PROFILE_PARAMETER_POLICIES.join(', ')}`);
  }
  if (!profile.scope?.actualSymbol) errors.push('profile.scope.actualSymbol is required');
  if (!profile.scope?.timeframe) errors.push('profile.scope.timeframe is required');
  if (!profile.scope?.costs) errors.push('profile.scope.costs is required');
  if (!profile.selection?.params || typeof profile.selection.params !== 'object') {
    errors.push('profile.selection.params is required');
  }
  if (profile.selection?.neighborhood != null) {
    const checked = neighborhoodEvidence({
      neighborhood: profile.selection.neighborhood,
      selectedParams: profile.selection.params,
      actualSymbol: profile.scope?.actualSymbol,
      timeframe: normalizeTimeframe(profile.scope?.timeframe),
      costs: profile.scope?.costs,
      range: profile.scope?.range,
      selectedSourceSha256: profile.strategy?.sourceSha256,
    });
    errors.push(...checked.errors.map(error => `profile.selection.${error}`));
  }
  for (const key of ['strategyPct', 'buyHoldPct', 'alphaPct', 'maxDrawdownPct', 'profitFactor', 'trades', 'winPct']) {
    if (!isFiniteOrNull(profile.performance?.[key])) errors.push(`profile.performance.${key} must be finite or null`);
  }
  if (!PROFILE_VERDICT_LABELS.includes(profile.verdict?.label)) {
    errors.push(`profile.verdict.label must be one of ${PROFILE_VERDICT_LABELS.join(', ')}`);
  }
  if (!['qualified', 'insufficient'].includes(profile.verdict?.quality)) {
    errors.push('profile.verdict.quality must be qualified or insufficient');
  }
  if (!Array.isArray(profile.verdict?.flags) || !Array.isArray(profile.verdict?.reasons)) {
    errors.push('profile.verdict flags and reasons must be arrays');
  }
  if (!profile.artifacts || typeof profile.artifacts !== 'object') errors.push('profile.artifacts is required');
  if (profile.verdict?.label !== 'unverified' && !profile.scope?.range) {
    errors.push('qualified profile.scope.range is required');
  }
  if (profile.verdict?.label === 'cross_market' && profile.scope?.parameterPolicy !== 'fixed_cross_market') {
    errors.push('cross_market verdict requires fixed_cross_market parameter policy');
  }
  if (mode === 'runtime' && profile.promotion?.status !== 'runtime_only') {
    errors.push('runtime profile promotion.status must be runtime_only');
  }
  if (mode === 'promoted' && !['review_required', 'promoted'].includes(profile.promotion?.status)) {
    errors.push('promoted profile promotion.status must be review_required or promoted');
  }
  if (mode === 'promoted') inspectPromotedValue(profile, '', errors);
  return { errors: [...new Set(errors)], warnings };
}

function sanitizeValue(value, key = '') {
  if (isSecretLikeKey(key)) return undefined;
  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item)).filter(item => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const entries = [];
    for (const [childKey, item] of Object.entries(value)) {
      const clean = sanitizeValue(item, childKey);
      if (clean !== undefined) entries.push([childKey, clean]);
    }
    return Object.fromEntries(entries);
  }
  if (containsPineSource(value)) return undefined;
  if (/sourcePath/i.test(key)) return undefined;
  if (isAbsoluteLike(value) && /path$/i.test(key)) return undefined;
  return value;
}

export function sanitizeProfileForPromotion(profile) {
  const sanitized = sanitizeValue(structuredClone(profile));
  sanitized.artifacts = Object.fromEntries(Object.entries(sanitized.artifacts || {}).map(([key, value]) => [
    key,
    typeof value === 'string' && isAbsoluteLike(value) ? basename(value) : value,
  ]));
  sanitized.promotion = { status: 'review_required' };
  return sanitized;
}
