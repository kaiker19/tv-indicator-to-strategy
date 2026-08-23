import { parseNum, parsePct, scanObjectiveFromMetrics } from './scan_summary.mjs';

const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
export const DEFAULT_OPTIMIZATION_BUDGET = 30;

export function resolveOptimizationBudget(total, requested = null) {
  const available = Math.max(0, Math.floor(Number(total) || 0));
  if (!available) return 0;
  const explicit = Number(requested);
  const cap = Number.isFinite(explicit) && explicit > 0
    ? Math.floor(explicit)
    : DEFAULT_OPTIMIZATION_BUDGET;
  return Math.min(available, cap);
}

export function parseAxisSpec(spec) {
  const m = String(spec || '').match(/^(.+?)=(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)(?::(-?\d+(?:\.\d+)?))?$/);
  if (!m) throw new Error(`bad axis spec: ${spec} (expected Name=start..end:step)`);
  return {
    name: m[1],
    start: parseFloat(m[2]),
    end: parseFloat(m[3]),
    step: parseFloat(m[4] || '1'),
  };
}

export function normalizeAxis(axis) {
  const name = axis?.name;
  const start = Number(axis?.start ?? axis?.min);
  const end = Number(axis?.end ?? axis?.max);
  const rawStep = Number(axis?.step ?? 1);
  if (!name) throw new Error('axis.name is required');
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`axis ${name} requires finite start/end`);
  if (!Number.isFinite(rawStep) || rawStep === 0) throw new Error(`axis ${name} requires non-zero step`);
  const dir = start <= end ? 1 : -1;
  const step = Math.abs(rawStep) * dir;
  const values = [];
  const eps = Math.abs(step) / 1000 || 1e-9;
  if (dir > 0) {
    for (let v = start; v <= end + eps; v += step) values.push(round6(v));
  } else {
    for (let v = start; v >= end - eps; v += step) values.push(round6(v));
  }
  return { name, start, end, step: Math.abs(rawStep), values: [...new Set(values)] };
}

function cartesian(axes) {
  let combos = [{}];
  for (const ax of axes) {
    const next = [];
    for (const combo of combos) {
      for (const value of ax.values) next.push({ ...combo, [ax.name]: value });
    }
    combos = next;
  }
  return combos;
}

function sampleEvenly(items, budget) {
  if (!budget || budget >= items.length) return items.slice();
  if (budget <= 1) return items.slice(0, 1);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < budget; i++) {
    const idx = Math.round(i * (items.length - 1) / (budget - 1));
    if (!seen.has(idx)) {
      out.push(items[idx]);
      seen.add(idx);
    }
  }
  for (let i = 0; out.length < budget && i < items.length; i++) {
    if (!seen.has(i)) {
      out.push(items[i]);
      seen.add(i);
    }
  }
  return out;
}

export function buildCoarseGrid(rawAxes, budget = null) {
  const axes = rawAxes.map(normalizeAxis);
  const full = cartesian(axes);
  const cap = Number.isFinite(Number(budget)) && Number(budget) > 0 ? Math.floor(Number(budget)) : full.length;
  const combos = sampleEvenly(full, cap);
  return { axes, combos, total: full.length, budget: cap, truncated: combos.length < full.length };
}

function valueOf(row, objective = 'risk_adjusted', trustRowObjective = true) {
  if (trustRowObjective && Number.isFinite(Number(row.objective))) return Number(row.objective);
  return scanObjectiveFromMetrics({
    total_pnl: row.net_pnl ?? row.total_pnl ?? row.strategy,
    max_drawdown: row.max_drawdown ?? row.dd,
    profit_factor: row.profit_factor ?? row.pf,
    buy_hold_return: row.buy_hold_return ?? row.bh ?? row.bh_pct,
    total_trades: row.total_trades ?? row.trades,
    winning_trades: row.winning_trades ?? row.wins,
    win_pct: row.win_pct ?? row.percent_profitable,
  }, objective);
}

function pctOrNum(v) {
  const pct = parsePct(v);
  if (Number.isFinite(pct)) return pct;
  const n = parseNum(v);
  return Number.isFinite(n) ? n : null;
}

function rowRet(row) {
  const direct = Number(row.ret ?? row.strategy ?? row.strategy_pct);
  if (Number.isFinite(direct)) return direct;
  return pctOrNum(row.net_pnl ?? row.total_pnl);
}

function rowBh(row) {
  const direct = Number(row.bh ?? row.bh_pct);
  if (Number.isFinite(direct)) return direct;
  return pctOrNum(row.buy_hold_return);
}

function rowAlpha(row) {
  const direct = Number(row.alpha ?? row.alpha_pct);
  if (Number.isFinite(direct)) return direct;
  const ret = rowRet(row);
  const bh = rowBh(row);
  return ret != null && bh != null ? round6(ret - bh) : null;
}

function rowDd(row) {
  return pctOrNum(row.max_drawdown ?? row.dd);
}

function areAdjacent(a, b, axes) {
  let diffAxes = 0;
  for (const ax of axes) {
    const ai = ax.values.indexOf(a.params[ax.name]);
    const bi = ax.values.indexOf(b.params[ax.name]);
    const d = Math.abs(ai - bi);
    if (d === 1) diffAxes++;
    else if (d > 1) return false;
  }
  return diffAxes === 1;
}

export function classifySurface(rows, rawAxes, objective = 'risk_adjusted') {
  const axes = rawAxes.map(a => Array.isArray(a.values) ? a : normalizeAxis(a));
  const scored = rows
    .map(row => ({ row, score: valueOf(row, objective) }))
    .filter(x => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score);
  if (axes.length !== 2 || scored.length < 4) {
    return { type: 'insufficient', verdict: '有效参数格太少，暂不能判断参数形状。' };
  }

  const best = scored[0];
  const spread = Math.max(1, Math.abs(best.score) * 0.15);
  const top = scored.filter(x => best.score - x.score <= spread);
  const adjacentTop = top.some((x, i) => top.slice(i + 1).some(y => areAdjacent(x.row, y.row, axes)));

  if (objective === 'alpha' && best.score <= 0) {
    return { type: 'no_edge', verdict: '全部参数格都落后 B&H；即使表面平坦，也只是稳定地没有超额收益。', topCells: top.length };
  }

  const returns = scored.map(({ row }) => rowRet(row));
  if (returns.length && returns.every(ret => ret != null && ret <= 0)) {
    return { type: 'no_edge', verdict: '全部有效参数格的策略收益都不为正；分数接近只代表结果同样偏弱，不构成参数高原。', topCells: top.length };
  }

  if (top.length >= 3 && adjacentTop) {
    return { type: 'plateau', verdict: '参数高原较宽，稳定性较好。', topCells: top.length };
  }

  const neighbors = scored.filter(x => areAdjacent(best.row, x.row, axes));
  const neighborMax = neighbors.length ? Math.max(...neighbors.map(x => x.score)) : -Infinity;
  if (!top.some(x => x !== best) && best.score - neighborMax > Math.max(1, Math.abs(best.score) * 0.4)) {
    return { type: 'isolated_peak', verdict: '最优格较孤立，疑似过拟合。', topCells: 1 };
  }

  const sameX = top.filter(x => x.row.params[axes[0].name] === best.row.params[axes[0].name]).length;
  const sameY = top.filter(x => x.row.params[axes[1].name] === best.row.params[axes[1].name]).length;
  if (top.length >= 2 && (sameX === top.length || sameY === top.length)) {
    return { type: 'ridge', verdict: '收益沿单一参数轴形成脊线，另一轴较敏感。', topCells: top.length };
  }

  return { type: 'noisy', verdict: '参数表面结构不清晰，暂不宜只按最高点取参。', topCells: top.length };
}

function paramKey(params) {
  return JSON.stringify(Object.keys(params).sort().map(k => [k, params[k]]));
}

export function planLocalRefinement({ axes: rawAxes, bestParams, testedParams = [], budgetLeft = 0 }) {
  const axes = rawAxes.map(normalizeAxis);
  const tested = new Set(testedParams.map(paramKey));
  const valuesByAxis = axes.map((ax) => {
    const center = Number(bestParams[ax.name]);
    const step = ax.step / 2;
    return [center - step, center, center + step]
      .map(round6)
      .filter(v => v >= Math.min(ax.start, ax.end) - 1e-9 && v <= Math.max(ax.start, ax.end) + 1e-9);
  });

  let combos = [{}];
  for (let i = 0; i < axes.length; i++) {
    const ax = axes[i];
    const next = [];
    for (const combo of combos) for (const value of valuesByAxis[i]) next.push({ ...combo, [ax.name]: value });
    combos = next;
  }
  combos = combos.filter(c => paramKey(c) !== paramKey(bestParams) && !tested.has(paramKey(c)));
  const cap = Math.max(0, Math.floor(Number(budgetLeft) || 0));
  return { axes, combos: combos.slice(0, cap), budgetLeft: cap };
}

export function buildOptimizationSummary({
  mode = 'coarse-to-local',
  objective = 'risk_adjusted',
  evaluation = null,
  budget = null,
  axes: rawAxes = [],
  rows = [],
  topK = 5,
  coarse = null,
  refinement = null,
}) {
  const axes = rawAxes.map(a => Array.isArray(a.values) ? a : normalizeAxis(a));
  const comparisonStatus = evaluation?.comparisonStatus || 'unverified';
  const requestedObjective = evaluation?.requestedObjective || objective;
  const effectiveObjective = evaluation?.effectiveObjective
    || (requestedObjective === 'alpha' && comparisonStatus !== 'comparable' ? 'risk_adjusted' : requestedObjective);
  const trustRowObjective = effectiveObjective === requestedObjective;
  const ranked = rows
    .map(row => ({ row, score: valueOf(row, effectiveObjective, trustRowObjective) }))
    .filter(x => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score);

  const top = ranked.slice(0, topK).map(({ row, score }, idx) => {
    const ret = rowRet(row);
    const bh = rowBh(row);
    const alpha = rowAlpha(row);
    return {
      rank: idx + 1,
      params: row.params,
      ret,
      bh,
      alpha,
      beatBh: comparisonStatus === 'comparable' && alpha != null ? alpha > 0 : null,
      dd: rowDd(row),
      trades: pctOrNum(row.total_trades ?? row.trades),
      winPct: pctOrNum(row.win_pct ?? row.percent_profitable),
      pf: pctOrNum(row.profit_factor ?? row.pf),
      score: Math.round(score * 1000) / 1000,
      ...(effectiveObjective === 'win_rate_confidence' ? { winLowerBound: Math.round(score * 1000) / 1000 } : {}),
      benchmarkSource: row.benchmarkSource || row.benchmark_source || (bh != null ? 'scan_cell_benchmarking' : 'missing'),
    };
  });

  return {
    mode,
    objective: effectiveObjective,
    requestedObjective,
    effectiveObjective,
    evaluation: evaluation || {
      comparisonStatus: 'unverified',
      reason: 'range_unavailable',
      requestedObjective,
      effectiveObjective,
    },
    budget,
    evaluated: rows.length,
    axes: axes.map(ax => ({ name: ax.name, values: ax.values })),
    top,
    shape: classifySurface(ranked.map(({ row, score }) => ({ ...row, objective: score })), axes, effectiveObjective),
    ...(coarse ? { coarse } : {}),
    ...(refinement ? { refinement } : {}),
  };
}
