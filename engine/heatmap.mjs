// 纯函数：scan 行 → 热力图网格对象。不碰 CDP/fs，可单测。
const parsePct = (s) => {
  const cleaned = String(s ?? '').replace(/[−]/g, '-').replace(/,/g, '');
  const matches = [...cleaned.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)];
  if (matches.length) return parseFloat(matches[matches.length - 1][1]);
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};
const parseNum = (s) => { const m = String(s ?? '').replace(/[, ]/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
const uniqSorted = (arr) => [...new Set(arr)].sort((a, b) => a - b);

function rowScore(row, effectiveObjective, bhPct) {
  const ret = parsePct(row.net_pnl);
  const dd = parsePct(row.max_drawdown);
  const pf = parseNum(row.profit_factor);
  const directAlpha = row.alpha_pct != null && isFinite(Number(row.alpha_pct)) ? Number(row.alpha_pct) : null;
  const alpha = directAlpha != null ? directAlpha : (bhPct != null && isFinite(ret) ? ret - bhPct : null);
  if (effectiveObjective === 'alpha') return alpha;
  if (effectiveObjective === 'net_pnl') return ret;
  if (effectiveObjective === 'profit_factor') return pf;
  if (effectiveObjective === 'risk_adjusted') {
    if (!isFinite(ret)) return null;
    return isFinite(dd) && dd !== 0 ? ret / Math.abs(dd) : ret;
  }
  return Number.isFinite(Number(row.objective)) ? Number(row.objective) : null;
}

export function buildHeatmap(rows, axes, bhPct, fixedInputs = {}, evaluation = null) {
  const [ax, ay] = axes;
  const xName = ax.name, yName = ay.name;
  const comparisonStatus = evaluation?.comparisonStatus || 'unverified';
  const requestedObjective = evaluation?.requestedObjective || 'alpha';
  const effectiveObjective = evaluation?.effectiveObjective
    || (requestedObjective === 'alpha' && comparisonStatus !== 'comparable' ? 'risk_adjusted' : requestedObjective);
  const cells = rows.map(r => {
    const ret = parsePct(r.net_pnl);
    const rowAlpha = r.alpha_pct != null && isFinite(Number(r.alpha_pct)) ? Number(r.alpha_pct) : null;
    return {
      x: r.params[xName], y: r.params[yName],
      ret: isFinite(ret) ? ret : null,
      alpha: rowAlpha != null ? rowAlpha : ((bhPct != null && isFinite(ret)) ? +(ret - bhPct).toFixed(2) : null),
      trades: r.total_trades != null ? parseNum(r.total_trades) : null,
      pf: parseNum(r.profit_factor),
    };
  });
  const best = rows.reduce((current, row) => {
    const score = rowScore(row, effectiveObjective, bhPct);
    return score != null && score > (current?.score ?? -Infinity) ? { row, score } : current;
  }, null);
  const hasAlpha = cells.some(c => c.alpha != null);
  const allowAlpha = comparisonStatus === 'comparable' && hasAlpha;
  const comparisonNote = comparisonStatus === 'incompatible'
    ? '候选区间不一致，仅展示策略总收益。'
    : comparisonStatus === 'unverified'
      ? '基准区间未证明，仅展示策略总收益。'
      : '';
  return {
    metric: allowAlpha ? 'alpha' : 'ret',
    allowAlpha,
    comparisonStatus,
    comparisonNote,
    xParam: { name: xName, values: uniqSorted(rows.map(r => r.params[xName])) },
    yParam: { name: yName, values: uniqSorted(rows.map(r => r.params[yName])) },
    fixed: Object.entries(fixedInputs).map(([name, value]) => ({ name, value: String(value) })),
    best: best ? { x: best.row.params[xName], y: best.row.params[yName] } : null,
    bh_pct: bhPct ?? null,
    cells,
  };
}
