export function parseNum(str) {
  if (str == null) return NaN;
  const cleaned = String(str).replace(/[−]/g, '-').replace(/,/g, '');
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

export function parsePct(str) {
  if (str == null) return NaN;
  const cleaned = String(str).replace(/[−]/g, '-').replace(/,/g, '');
  const matches = [...cleaned.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)];
  if (!matches.length) return NaN;
  return parseFloat(matches[matches.length - 1][1]);
}

export function wilsonLowerBound(wins, total, z = 1.96) {
  const n = Number(total);
  const w = Number(wins);
  const confidenceZ = Number(z);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(w) || w < 0 || w > n || !Number.isFinite(confidenceZ)) {
    return -Infinity;
  }
  const p = w / n;
  const z2 = confidenceZ ** 2;
  const center = p + z2 / (2 * n);
  const margin = confidenceZ * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (center - margin) / (1 + z2 / n);
}

function parseWinningTrades(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (value == null) return NaN;
  const text = String(value).replace(/[−]/g, '-').replace(/,/g, '');
  const fraction = text.match(/(-?\d+(?:\.\d+)?)\s*\/\s*\d+(?:\.\d+)?/);
  if (fraction) return Number(fraction[1]);
  const countSegment = text.split('|').find(segment => !segment.includes('%') && /-?\d/.test(segment));
  if (countSegment) return parseNum(countSegment);
  return text.includes('%') ? NaN : parseNum(text);
}

function winRateEvidence(metrics = {}) {
  const trades = parseNum(metrics.total_trades ?? metrics.trades);
  let wins = parseWinningTrades(metrics.winning_trades ?? metrics.wins);
  let winPct = parsePct(metrics.win_pct ?? metrics.percent_profitable);
  if (!Number.isFinite(winPct)) {
    const numericPct = Number(metrics.win_pct ?? metrics.percent_profitable);
    if (Number.isFinite(numericPct)) winPct = numericPct;
  }
  if (!Number.isFinite(wins) && Number.isFinite(trades) && Number.isFinite(winPct)) {
    wins = trades * winPct / 100;
  }
  if (!Number.isFinite(winPct) && Number.isFinite(trades) && trades > 0 && Number.isFinite(wins)) {
    winPct = wins / trades * 100;
  }
  const lower = wilsonLowerBound(wins, trades);
  return {
    trades: Number.isFinite(trades) ? trades : null,
    winPct: Number.isFinite(winPct) ? winPct : null,
    winLowerBound: Number.isFinite(lower) ? lower * 100 : null,
  };
}

export function scanObjectiveFromMetrics(metrics = {}, objective = 'risk_adjusted') {
  if (objective === 'alpha') {
    const sp = parsePct(metrics.total_pnl);
    const bh = parsePct(metrics.buy_hold_return);
    return (isFinite(sp) && isFinite(bh)) ? +(sp - bh).toFixed(2) : -Infinity;
  }
  if (objective === 'net_pnl') {
    const pnl = parseNum(metrics.total_pnl);
    return isFinite(pnl) ? pnl : -Infinity;
  }
  if (objective === 'profit_factor') {
    const pf = parseNum(metrics.profit_factor);
    return isFinite(pf) ? pf : -Infinity;
  }
  if (objective === 'win_rate_confidence') {
    const { winLowerBound } = winRateEvidence(metrics);
    return winLowerBound ?? -Infinity;
  }

  const pnl = parseNum(metrics.total_pnl);
  const dd = parseNum(metrics.max_drawdown);
  if (!isFinite(pnl)) return -Infinity;
  if (!isFinite(dd) || dd === 0) return pnl;
  return pnl / dd;
}

function rowAlpha(row, fallbackBhPct = null) {
  if (row.alpha_pct != null && isFinite(Number(row.alpha_pct))) return Number(row.alpha_pct);
  const strategyPct = parsePct(row.net_pnl);
  const bhPct = row.bh_pct != null && isFinite(Number(row.bh_pct))
    ? Number(row.bh_pct)
    : parsePct(row.buy_hold_return);
  const resolvedBh = isFinite(bhPct) ? bhPct : fallbackBhPct;
  return (isFinite(strategyPct) && resolvedBh != null && Number.isFinite(Number(resolvedBh)))
    ? +(strategyPct - Number(resolvedBh)).toFixed(2)
    : null;
}

function rowBh(row, fallbackBhPct = null) {
  if (row.bh_pct != null && isFinite(Number(row.bh_pct))) return Number(row.bh_pct);
  const parsed = parsePct(row.buy_hold_return);
  return isFinite(parsed) ? parsed : fallbackBhPct;
}

export function buildScanSummary({
  pineFile,
  scriptName,
  symbol,
  costs,
  objective,
  objectiveLabel,
  evaluation = null,
  scanned,
  jsonlPath,
  results,
  fallbackBhPct = null,
}) {
  const comparisonStatus = evaluation?.comparisonStatus || 'unverified';
  const requestedObjective = evaluation?.requestedObjective || objective || 'risk_adjusted';
  const effectiveObjective = evaluation?.effectiveObjective
    || (requestedObjective === 'alpha' && comparisonStatus !== 'comparable' ? 'risk_adjusted' : requestedObjective);
  const trustRowObjective = effectiveObjective === requestedObjective;
  const rows = (results || []).map((row) => {
    const alphaPct = rowAlpha(row, fallbackBhPct);
    const bhPct = rowBh(row, fallbackBhPct);
    const winEvidence = winRateEvidence(row);
    const objectiveValue = trustRowObjective && isFinite(row.objective)
      ? row.objective
      : scanObjectiveFromMetrics({
          total_pnl: row.net_pnl,
          max_drawdown: row.max_drawdown,
          profit_factor: row.profit_factor,
          buy_hold_return: row.buy_hold_return,
          total_trades: row.total_trades,
          winning_trades: row.winning_trades,
          win_pct: row.win_pct,
        }, effectiveObjective);

    return {
      ...row,
      objective: objectiveValue,
      ...(bhPct != null ? { bh_pct: bhPct } : {}),
      ...(alphaPct != null ? { alpha_pct: alphaPct, beat_bh: alphaPct > 0 ? 'yes' : 'no' } : {}),
      ...(winEvidence.trades != null ? { trades: winEvidence.trades } : {}),
      ...(winEvidence.winPct != null ? { win_pct: winEvidence.winPct } : {}),
      ...(winEvidence.winLowerBound != null ? { win_lower_bound: winEvidence.winLowerBound } : {}),
    };
  });

  const ranked = rows.filter(r => isFinite(r.objective)).sort((a, b) => b.objective - a.objective);
  const K = Math.min(10, ranked.length);
  const compact = (r) => ({
    params: r.params,
    net_pnl: r.net_pnl,
    max_drawdown: r.max_drawdown,
    pf: r.profit_factor,
    obj: Math.round(r.objective * 1000) / 1000,
    ...(r.trades != null ? { trades: r.trades } : {}),
    ...(r.win_pct != null ? { win_pct: r.win_pct } : {}),
    ...(r.win_lower_bound != null ? { win_lower_bound: Math.round(r.win_lower_bound * 1000) / 1000 } : {}),
    ...(r.episode ? { episode: r.episode } : {}),
    ...(r.bh_pct != null ? { bh_pct: r.bh_pct } : {}),
    ...(r.alpha_pct != null ? { alpha_pct: r.alpha_pct, beat_bh: r.beat_bh } : {}),
  });

  const best = ranked[0] ? {
    params: ranked[0].params,
    net_pnl: ranked[0].net_pnl,
    max_drawdown: ranked[0].max_drawdown,
    profit_factor: ranked[0].profit_factor,
    objective: Math.round(ranked[0].objective * 1000) / 1000,
    ...(ranked[0].trades != null ? { trades: ranked[0].trades } : {}),
    ...(ranked[0].win_pct != null ? { win_pct: ranked[0].win_pct } : {}),
    ...(ranked[0].win_lower_bound != null ? { win_lower_bound: Math.round(ranked[0].win_lower_bound * 1000) / 1000 } : {}),
    ...(ranked[0].episode ? { episode: ranked[0].episode } : {}),
    ...(ranked[0].bh_pct != null ? { bh_pct: ranked[0].bh_pct } : {}),
    ...(ranked[0].alpha_pct != null ? { alpha_pct: ranked[0].alpha_pct, beat_bh: ranked[0].beat_bh } : {}),
  } : null;

  return {
    pine_file: pineFile,
    script_name: scriptName,
    symbol,
    ...(costs ? { costs } : {}),
    objective: objectiveLabel,
    requested_objective: requestedObjective,
    effective_objective: effectiveObjective,
    evaluation: evaluation || {
      comparisonStatus: 'unverified',
      reason: 'range_unavailable',
      requestedObjective,
      effectiveObjective,
    },
    scanned,
    jsonl: jsonlPath,
    bh_pct: fallbackBhPct,
    best_beats_bh: requestedObjective === 'alpha' && comparisonStatus === 'comparable' && best ? (best.beat_bh || 'no') : null,
    best,
    top: ranked.slice(0, K).map(compact),
  };
}
