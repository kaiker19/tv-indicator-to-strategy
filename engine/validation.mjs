import { parseNum, parsePct } from './scan_summary.mjs';

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function finiteNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pctOrNum(v) {
  const direct = finiteNum(v);
  if (direct != null) return direct;
  const pct = parsePct(v);
  if (Number.isFinite(pct)) return pct;
  const n = parseNum(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeBenchmarkRow(row = {}) {
  const strategy = pctOrNum(row.strategy ?? row.strategy_pct ?? row.ret ?? row.net_pnl ?? row.total_pnl);
  const bh = pctOrNum(row.bh ?? row.bh_pct ?? row.buy_hold_return);
  const explicitAlpha = pctOrNum(row.alpha ?? row.alpha_pct);
  const alpha = explicitAlpha != null ? explicitAlpha : (strategy != null && bh != null ? round2(strategy - bh) : null);
  const trades = pctOrNum(row.trades ?? row.total_trades);
  const pf = pctOrNum(row.pf ?? row.profit_factor);
  return {
    symbol: row.symbol ?? row.meta?.symbol ?? '(current)',
    strategy,
    bh,
    alpha,
    trades,
    pf,
    beatBh: alpha != null ? alpha > 0 : null,
    benchmarkSource: row.benchmarkSource ?? row.benchmark_source ?? null,
    error: row.error ?? null,
  };
}

export function summarizeValidationRows(rows = []) {
  const normalized = rows.map(normalizeBenchmarkRow);
  const valid = normalized.filter(r => r.alpha != null);
  const beat = valid.filter(r => r.alpha > 0).length;
  const total = normalized.length;
  const flags = [];

  if (!total || !valid.length) flags.push('insufficient_validation');
  if (total && beat === 0) flags.push('validation_0_of_n');
  if (normalized.some(r => r.trades != null && r.trades < 10)) flags.push('low_sample');
  if (normalized.some(r => r.pf != null && r.pf >= 20 && r.trades != null && r.trades < 10)) flags.push('extreme_pf_low_trades');
  if (normalized.some(r => r.alpha != null && r.alpha < 0)) flags.push('negative_alpha');
  if (normalized.some(r => r.bh != null && !r.benchmarkSource)) flags.push('missing_benchmark_source');

  let verdict = { type: 'watch', label: '可继续观察', detail: '验证集中仍有可观察结果，但不能替代真实样本外。' };
  if (flags.includes('insufficient_validation')) {
    verdict = { type: 'low_sample', label: '样本不足', detail: '验证数据不足，不能给出稳健结论。' };
  } else if (flags.includes('low_sample') || flags.includes('extreme_pf_low_trades')) {
    verdict = { type: 'low_sample', label: '样本不足', detail: '交易笔数过少或 PF 异常偏高，结论需要降权。' };
  } else if (flags.includes('validation_0_of_n')) {
    verdict = { type: 'unstable', label: '明显不稳', detail: '验证集没有一个市场跑赢 B&H。' };
  } else if (valid.length && beat / valid.length < 0.5) {
    verdict = { type: 'overfit', label: '疑似过拟合', detail: '跑赢市场不足半数，优化结果可能依赖单一行情。' };
  }

  return {
    kind: 'multi_symbol',
    rows: normalized,
    beat,
    total,
    beatBh: `${beat} / ${total}`,
    flags,
    verdict,
  };
}

function pct(v) {
  return v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}

export function buildTrustVerdict({ optimization = null, validation = null, oos = null } = {}) {
  const evidence = [];
  const best = optimization?.top?.[0];
  if (best) {
    evidence.push({
      label: '优化最优格',
      value: `${pct(best.ret)} vs B&H ${pct(best.bh)}`,
      status: best.alpha > 0 ? 'win' : 'fail',
    });
  }
  if (validation) {
    evidence.push({
      label: '验证结果',
      value: `跑赢 ${validation.beatBh || `${validation.beat ?? 0} / ${validation.total ?? 0}`}`,
      status: validation.beat === 0 ? 'fail' : validation.verdict?.type === 'low_sample' ? 'warn' : 'win',
    });
  }
  if (oos?.status) {
    evidence.push({
      label: 'OOS',
      value: oos.status === 'real' ? (oos.decay?.verdict || '已验证') : '未证明真实样本外',
      status: oos.status === 'real' && oos.decay?.ret_pct > -50 ? 'win' : 'warn',
    });
  }
  if (optimization?.shape?.type) {
    evidence.push({
      label: '参数形状',
      value: optimization.shape.verdict,
      status: optimization.shape.type === 'plateau' ? 'win' : optimization.shape.type === 'insufficient' ? 'warn' : 'fail',
    });
  }

  let type = 'watch';
  let headline = '可继续观察，但仍需验证';
  let detail = '优化结果需要同时看参数形状、B&H 口径和验证集表现。';

  if (validation?.verdict?.type === 'unstable' || optimization?.shape?.type === 'isolated_peak' || oos?.decay?.ret_pct <= -70) {
    type = 'overfit';
    headline = '结果疑似过拟合或明显不稳';
    detail = '最优参数不能只看单格收益；验证失败、孤立亮格或测试段衰减都会降低可信度。';
  } else if (validation?.verdict?.type === 'low_sample') {
    type = 'low_sample';
    headline = '样本不足，暂不宜下结论';
    detail = validation.verdict.detail;
  } else if (optimization?.shape?.type === 'plateau' && (!validation || validation.verdict?.type === 'watch')) {
    type = 'watch';
    headline = '参数形状较稳，可继续观察';
    detail = '优化结果出现参数高原，但仍建议继续做多市场或真实样本外验证。';
  }

  return { type, headline, detail, evidence: evidence.slice(0, 3) };
}
