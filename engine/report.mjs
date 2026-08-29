// 指标评估 HTML 报告生成器（白底文档式，以留白和浅底内容组分区，自包含可截图分享）。
// 用法: node report.mjs <data.json>   → 写出 data.out（默认 ~/.tv-skill/report.html）
// 纯数据→HTML，不碰 TV/CDP。数据契约（v0 shape）见 engine-cli.md「生成可视化报告」。
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { pathToFileURL } from 'url';

export const REPORT_TEMPLATE_VERSION = 1;

const isNum = (v) => typeof v === 'number' && isFinite(v);

const numberValue = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const displayPct = (v) => {
  const n = numberValue(v);
  return n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};

const marketKey = (value) => {
  const text = String(value || '').toUpperCase();
  if (/(^|:)QQQ\b/.test(text)) return 'QQQ';
  if (/(^|:)SPY\b/.test(text)) return 'SPY';
  if (/510300|CSI\s*300|CSI300|沪深\s*300/.test(text)) return 'CSI300';
  return text.replace(/^.*:/, '').trim();
};

const marketLabel = (value) => ({
  QQQ: 'QQQ',
  SPY: 'SPY',
  CSI300: '沪深300',
}[marketKey(value)] || String(value || ''));

const verdictLabel = (type) => ({
  win: '通过验证',
  lose: '未跑赢基准',
  overfit: '过拟合风险',
  caution: '需要谨慎',
  fail: '验证未通过',
}[type] || type || '');

export function buildCaseSummary(d = {}) {
  const rows = Array.isArray(d.robustness?.rows) ? d.robustness.rows.filter(Boolean) : [];
  const primaryRow = rows.find((row) => marketKey(row.symbol) === marketKey(d.symbol)) || rows[0] || null;
  const reportStats = d.stats || {};
  const primaryMatchesReport = primaryRow && marketKey(primaryRow.symbol) === marketKey(d.symbol);
  const source = primaryRow ? {
    ...primaryRow,
    strat: primaryRow.strat ?? primaryRow.strategy_pct ?? (primaryMatchesReport ? reportStats.ret : null),
    bh: primaryRow.bh ?? primaryRow.bh_pct ?? (primaryMatchesReport ? reportStats.bh : null),
    alpha: primaryRow.alpha ?? primaryRow.alpha_pct ?? (primaryMatchesReport ? reportStats.alpha : null),
    dd: primaryRow.dd ?? primaryRow.drawdown ?? primaryRow.max_drawdown ?? (primaryMatchesReport ? reportStats.dd : null),
    pf: primaryRow.pf ?? primaryRow.profit_factor ?? (primaryMatchesReport ? reportStats.pf : null),
    trades: primaryRow.trades ?? (primaryMatchesReport ? reportStats.trades : null),
  } : {
    symbol: d.symbol,
    strat: reportStats.ret,
    bh: reportStats.bh,
    alpha: reportStats.alpha,
    dd: reportStats.dd,
    pf: reportStats.pf,
    trades: reportStats.trades,
  };
  const strategy = numberValue(source.strat ?? source.strategy_pct);
  const bh = numberValue(source.bh ?? source.bh_pct);
  const alpha = numberValue(source.alpha ?? source.alpha_pct);
  const dd = numberValue(source.dd ?? source.drawdown ?? source.max_drawdown);
  const pf = numberValue(source.pf ?? source.profit_factor);
  const trades = numberValue(source.trades);
  const axes = Array.isArray(d.optimization?.axes) ? d.optimization.axes : [];
  const evaluated = numberValue(d.optimization?.evaluated);
  const researchDepth = d.researchDepth?.label
    || (d.optimization ? `${axes.length || '多'} 参数有界搜索${evaluated != null ? ` · ${evaluated} 组` : ''}` : '')
    || (rows.length >= 3 ? '完整基线 · 三市场固定参数验证' : '完整基线');
  const scope = ['回测', marketLabel(source.symbol || d.symbol), d.timeframe].filter(Boolean).join(' · ');

  return {
    schemaVersion: 2,
    reportTemplateVersion: REPORT_TEMPLATE_VERSION,
    title: d.title || '指标评估',
    kind: d.card?.kind || d.type || '指标研究',
    status: d.card?.status || verdictLabel(d.verdict?.type),
    principle: d.card?.principle || d.oneLiner || d.explain?.howItWorks || '',
    scope,
    researchDepth,
    primaryMarket: {
      symbol: marketLabel(source.symbol || d.symbol),
      range: source.range || '',
      strategy,
      bh,
      alpha,
      dd,
      pf,
      trades,
    },
    metrics: [
      {
        label: '策略收益',
        value: displayPct(strategy),
        sub: bh != null ? `B&H ${displayPct(bh)}` : '',
        tone: strategy == null ? 'plain' : strategy > 0 ? 'pos' : strategy < 0 ? 'neg' : 'plain',
      },
      {
        label: '最大回撤',
        value: dd == null ? '—' : `-${Math.abs(dd).toFixed(2)}%`,
        sub: '',
        tone: dd == null ? 'plain' : 'neg',
      },
      {
        label: '盈亏比 PF',
        value: pf == null ? '—' : pf.toFixed(2),
        sub: trades == null ? '' : `${Math.round(trades)} 笔交易`,
        tone: 'plain',
      },
    ],
  };
}

function evaluationView(data = {}, alpha = null) {
  const evaluation = data.evaluation || null;
  const status = evaluation?.comparisonStatus || 'unverified';
  const alphaNumber = typeof alpha === 'number' ? alpha : parseFloat(alpha);
  const positive = Number.isFinite(alphaNumber) && alphaNumber > 0;
  if (status === 'comparable') {
    return {
      status,
      allowCandidateAlpha: true,
      benchmarkText: positive ? '跑赢' : '未跑赢',
      note: '候选区间已验证可比。',
      alphaLabel: '超额收益 α',
      trustText: '候选区间已验证可比',
    };
  }
  if (status === 'single_run') {
    return {
      status,
      allowCandidateAlpha: false,
      benchmarkText: positive ? '本次跑赢' : '本次未跑赢',
      note: '',
      alphaLabel: '相对 B&H',
      trustText: '同次回测相对 B&amp;H',
    };
  }
  if (status === 'incompatible') {
    const benchmarkDrift = evaluation?.reason === 'benchmark_value_drift';
    return {
      status,
      allowCandidateAlpha: false,
      benchmarkText: benchmarkDrift ? 'B&H 数值漂移' : '区间不一致',
      note: benchmarkDrift
        ? '候选区间一致，但 B&H 数值漂移，alpha 不用于调参排名。'
        : '候选区间不一致，alpha 不用于调参排名。',
      alphaLabel: '同格收益差',
      trustText: benchmarkDrift ? 'B&amp;H 数值漂移' : '候选区间不一致',
    };
  }
  return {
    status: 'unverified',
    allowCandidateAlpha: false,
    benchmarkText: '区间未证明',
    note: '基准区间未证明，alpha 不用于调参排名。',
    alphaLabel: '同格收益差',
    trustText: '基准区间未证明',
  };
}

export function validateData(d) {
  const errors = [], warnings = [];
  if (!d || typeof d !== 'object') { errors.push('data 必须是 JSON 对象'); return { errors, warnings }; }
  if (typeof d.title !== 'string' || !d.title.trim()) errors.push('缺少必填 title（字符串）');
  if (!d.partial && (typeof d.source !== 'string' || !d.source.trim())) errors.push('完整报告缺少必填 source（Pine 源码）；诊断报告请显式设置 partial:true');
  const blocks = ['stats', 'explain', 'beforeAfter', 'robustness', 'screenshot', 'heatmap', 'optimization', 'validation', 'oos'];
  if (!blocks.some(k => d[k])) errors.push('至少要有一个内容块（stats/explain/beforeAfter/robustness/screenshot/heatmap/optimization/validation/oos）');
  if (d.stats) for (const k of ['ret', 'alpha', 'bh', 'dd', 'pf', 'trades'])
    if (d.stats[k] != null && !isNum(d.stats[k])) errors.push(`stats.${k} 应为数字，收到 ${JSON.stringify(d.stats[k])}`);
  if (d.costs) for (const k of ['commission', 'slippage'])
    if (d.costs[k] != null && typeof d.costs[k] !== 'string') warnings.push(`costs.${k} 建议为字符串，收到 ${JSON.stringify(d.costs[k])}`);
  if (d.scope != null && typeof d.scope !== 'string') warnings.push(`scope 建议为字符串，收到 ${JSON.stringify(d.scope)}`);
  if (d.card != null && (typeof d.card !== 'object' || Array.isArray(d.card))) warnings.push(`card 建议为对象，收到 ${JSON.stringify(d.card)}`);
  if (d.researchDepth != null && (typeof d.researchDepth !== 'object' || Array.isArray(d.researchDepth))) warnings.push(`researchDepth 建议为对象，收到 ${JSON.stringify(d.researchDepth)}`);
  if (d.heatmap) {
    const h = d.heatmap;
    if (!Array.isArray(h.cells) || !h.cells.length) errors.push('heatmap.cells 应为非空数组');
    if (!h.xParam?.name || !Array.isArray(h.xParam?.values)) errors.push('heatmap.xParam 需含 name 与 values[]');
    if (!h.yParam?.name || !Array.isArray(h.yParam?.values)) errors.push('heatmap.yParam 需含 name 与 values[]');
  }
  const optimizationTop = Array.isArray(d.optimization?.top) ? d.optimization.top.filter(Boolean) : [];
  optimizationTop.forEach((row, index) => {
    const trades = numberValue(row?.trades ?? row?.total_trades);
    const pf = numberValue(row?.pf ?? row?.profit_factor);
    if (trades != null && trades > 0 && pf == null) {
      errors.push(`optimization.top[${index}].pf 缺失：有交易的候选必须保留 Strategy Tester 的 PF`);
    }
  });
  const deep = d.explain?.deep;
  const equations = Array.isArray(deep?.equations) ? deep.equations.filter(Boolean) : [];
  if (equations.length) {
    const variables = Array.isArray(deep?.variables) ? deep.variables.filter(Boolean) : [];
    const definedSymbols = new Set(variables.map(item => String(item?.symbol || '').trim()).filter(Boolean));
    if (!variables.length) errors.push('explain.deep.equations 存在时必须提供 variables[]，定义公式中的全部符号');
    if (typeof deep?.example !== 'string' || !deep.example.trim()) {
      errors.push('explain.deep.equations 存在时必须提供 example，用 3–6 个简化数值走一遍计算');
    }
    equations.forEach((equation, index) => {
      if (typeof equation?.label !== 'string' || !equation.label.trim()) errors.push(`explain.deep.equations[${index}].label 不能为空`);
      if (typeof equation?.expression !== 'string' || !equation.expression.trim()) errors.push(`explain.deep.equations[${index}].expression 不能为空`);
      if (!Array.isArray(equation?.symbols) || !equation.symbols.length) {
        errors.push(`explain.deep.equations[${index}].symbols 必须列出本式使用的符号`);
      } else {
        const missing = equation.symbols.map(symbol => String(symbol).trim()).filter(symbol => symbol && !definedSymbols.has(symbol));
        if (missing.length) errors.push(`explain.deep.equations[${index}] 存在未定义符号: ${missing.join(', ')}`);
      }
    });
  }
  if (d.screenshot && !existsSync(d.screenshot)) warnings.push(`screenshot 路径不存在，将跳过截图: ${d.screenshot}`);
  return { errors, warnings };
}

export function buildShareCard(d) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
  const pct = (v) => { const n = num(v); return isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : '—'; };
  const mag = (v) => { const n = num(v); return isFinite(n) ? n.toFixed(2) + '%' : '—'; };
  const sgn = (v) => { const n = num(v); return !isFinite(n) ? 'neu' : n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu'; };
  const st = d.stats || {};
  const verdict = d.verdict || {};
  const evaluation = evaluationView(d, st.alpha);
  const riskLabels = {
    overfit: '过拟合 高风险',
    lose: '未跑赢基准',
    caution: '需要谨慎',
    fail: '验证未通过',
  };
  const isRisk = verdict.type in riskLabels;
  const beatBenchmark = ['comparable', 'single_run'].includes(evaluation.status) && num(st.alpha) > 0;
  const costItems = d.costs ? [
    d.costs.commission ? `手续费 ${esc(d.costs.commission)}` : '',
    d.costs.slippage ? `滑点 ${esc(d.costs.slippage)}` : '',
  ].filter(Boolean) : [];
  const researchDepth = typeof d.researchDepth === 'string' ? d.researchDepth : d.researchDepth?.label;
  const trustItems = [
    d.robustness?.beatBh ? { label: '多市场验证', value: `跑赢 ${esc(d.robustness.beatBh)}` } : null,
    researchDepth ? { label: '研究深度', value: esc(researchDepth) } : null,
    st.trades != null ? { label: '样本量', value: `${esc(st.trades)} 笔交易` } : null,
    costItems.length ? { label: '回测成本', value: costItems.join(' · ') } : null,
    { label: '诚实结论', value: evaluation.status === 'comparable' ? (verdict.type === 'lose' ? '未证明优于持有' : isRisk ? '高风险，先别实盘' : '仍需样本外验证') : evaluation.trustText },
  ].filter(Boolean);
  const trustHtml = trustItems.map(i => `<div class="trust-item"><div class="trust-lab">${esc(i.label)}</div><div class="trust-val">${i.value}</div></div>`).join('');
  const principle = d.sharePrinciple || '';
  const shareOrigin = d.shareUrl ? String(d.shareUrl).replace(/^https?:\/\//i, '') : '由 tv-indicator-to-strategy 生成';

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="tv-indicator-report-template" content="${REPORT_TEMPLATE_VERSION}"/>
<meta name="viewport" content="width=1080, initial-scale=1"/>
<title>${esc(d.title || '策略分享卡')}</title>
<style>
  :root{ --bg:#ffffff; --z50:#fafafa; --z100:#f4f4f5; --z200:#e4e4e7; --z400:#a1a1aa; --z500:#71717a; --z600:#52525b; --z700:#3f3f46; --z800:#27272a; --z900:#18181b; --pos:#059669; --neg:#ef4444; --warn:#b45309; --font:"Inter",-apple-system,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{ background:#e5e7eb; font-family:var(--font); color:var(--z900); }
  .share-card{ width:1080px; height:1350px; background:var(--bg); padding:72px; display:flex; flex-direction:column; gap:42px; }
  .top{ display:flex; justify-content:space-between; align-items:flex-start; gap:32px; }
  .benchmark-verdict{ flex:0 0 auto; min-width:138px; text-align:right; padding-bottom:10px; border-bottom:3px solid currentColor; }
  .benchmark-verdict.risk{ color:var(--warn); }
  .benchmark-verdict.ok{ color:var(--pos); }
  .benchmark-label{ color:var(--z400); font-size:19px; font-weight:700; line-height:1.3; }
  .benchmark-value{ margin-top:6px; font-size:28px; font-weight:800; line-height:1.2; white-space:nowrap; }
  h1{ max-width:740px; font-size:58px; line-height:1.1; letter-spacing:0; color:var(--z900); }
  .share-scope{ margin-top:-24px; color:var(--z400); font-size:21px; font-weight:650; line-height:1.4; }
  .headline{ font-size:34px; line-height:1.35; font-weight:700; color:var(--z800); }
  .one{ font-size:28px; line-height:1.55; color:var(--z600); }
  .principle-lab{ color:var(--z400); font-size:20px; font-weight:700; margin-bottom:8px; }
  .principle-text{ font-size:27px; line-height:1.5; color:var(--z600); display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; }
  .stats{ display:grid; grid-template-columns:1fr 1fr; gap:26px 32px; border-top:1px solid var(--z100); border-bottom:1px solid var(--z100); padding:36px 0; }
  .lab{ font-size:22px; color:var(--z400); font-weight:600; }
  .val{ margin-top:10px; font-size:50px; font-weight:800; line-height:1.05; font-variant-numeric:tabular-nums; }
  .sub{ margin-top:8px; font-size:21px; color:var(--z400); }
  .pos{ color:var(--pos); } .neg{ color:var(--neg); } .neu{ color:var(--z400); } .plain{ color:var(--z800); }
  .trust-grid{ display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .trust-item{ border-top:1px solid var(--z100); padding-top:18px; min-height:108px; }
  .trust-lab{ color:var(--z400); font-size:21px; font-weight:700; }
  .trust-val{ margin-top:8px; color:var(--z800); font-size:28px; line-height:1.35; font-weight:760; }
  .risk-note{ color:var(--z500); font-size:23px; line-height:1.55; border-top:1px solid var(--z100); padding-top:22px; }
  .foot{ margin-top:auto; display:flex; justify-content:space-between; align-items:flex-end; gap:28px; color:var(--z400); font-size:20px; line-height:1.5; border-top:1px solid var(--z100); padding-top:30px; }
</style></head><body><div class="share-card">
  <div class="top">
    <h1>${esc(d.title || '策略回测')}</h1>
    <div class="benchmark-verdict ${beatBenchmark ? 'ok' : 'risk'}"><div class="benchmark-label">基准结论</div><div class="benchmark-value">${evaluation.benchmarkText}</div></div>
  </div>
  ${d.shareScope ? `<div class="share-scope">${esc(d.shareScope)}</div>` : ''}
  ${verdict.headline ? `<div class="headline">${esc(verdict.headline)}</div>` : ''}
  ${principle ? `<div class="principle"><div class="principle-lab">原理</div><div class="principle-text">${esc(principle)}</div></div>` : d.oneLiner ? `<div class="one">${esc(d.oneLiner)}</div>` : ''}
  <div class="stats">
    <div><div class="lab">策略总收益</div><div class="val ${sgn(st.ret)}">${pct(st.ret)}</div></div>
    <div><div class="lab">${evaluation.alphaLabel}</div><div class="val ${sgn(st.alpha)}">${pct(st.alpha)}</div><div class="sub">B&H ${pct(st.bh)}</div></div>
    <div><div class="lab">最大回撤</div><div class="val neg">-${mag(st.dd)}</div></div>
    <div><div class="lab">盈亏比 / 交易数</div><div class="val plain">${st.pf != null ? esc(num(st.pf).toFixed(2)) : '—'}</div><div class="sub">${st.trades != null ? esc(st.trades) + ' 笔交易' : '—'}</div></div>
  </div>
  <div class="trust-grid">${trustHtml}</div>
  ${verdict.detail ? `<div class="risk-note">${esc(verdict.detail)}</div>` : ''}
  <div class="foot"><span>${esc(shareOrigin)}</span><span>非投资建议</span></div>
</div></body></html>`;
}

export function buildHtml(d) {
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
const pct = (v) => { const n = num(v); return isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : '—'; };
const mag = (v) => { const n = num(v); return isFinite(n) ? n.toFixed(2) + '%' : '—'; };
const sgn = (v) => { const n = num(v); return !isFinite(n) ? 'neu' : n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu'; };
const evaluation = evaluationView(d, d.stats?.alpha);
const caseSummary = buildCaseSummary(d);
const caseSummaryJson = JSON.stringify(caseSummary)
  .replace(/&/g, '\\u0026')
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e');

const copySvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

let shotImg = '';
if (d.screenshot && existsSync(d.screenshot)) {
  try { const b64 = readFileSync(d.screenshot).toString('base64'); shotImg = `<img class="shot" src="data:image/png;base64,${b64}" alt="回测截图"/>`; } catch {}
}

// —— Stat row（4 列竖线分隔，无卡片）——
const st = d.stats || {};
const statRow = d.stats ? `
  <div class="stats">
    <div class="stat"><div class="s-lab">策略总收益</div><div class="s-val ${sgn(st.ret)}">${pct(st.ret)}</div></div>
    <div class="stat"><div class="s-lab">${evaluation.alphaLabel}</div><div class="s-val ${sgn(st.alpha)}">${pct(st.alpha)}</div><div class="s-sub">B&amp;H ${pct(st.bh)}</div></div>
    <div class="stat"><div class="s-lab">最大回撤</div><div class="s-val neg">-${mag(st.dd)}</div></div>
    <div class="stat"><div class="s-lab">盈亏比 PF</div><div class="s-val plain">${st.pf != null ? esc(num(st.pf).toFixed(2)) : '—'}</div>${st.trades != null ? `<div class="s-sub">${esc(st.trades)} 笔交易</div>` : ''}</div>
  </div>` : '';

const costItems = d.costs ? [
  d.costs.commission ? `手续费 ${esc(d.costs.commission)}` : '',
  d.costs.slippage ? `滑点 ${esc(d.costs.slippage)}` : '',
].filter(Boolean) : [];
const scopeText = d.scope || [d.symbol, d.timeframe].filter(Boolean).join(' · ');
const runLineItems = [scopeText ? `回测：${esc(scopeText)}` : '', ...costItems].filter(Boolean);
const costBlock = runLineItems.length ? `<div class="costline">${runLineItems.join(' · ')}</div>` : '';

// —— Verdict evidence strip ——
const verdict = d.verdict || {};
const verdictIsRisk = ['overfit', 'lose', 'caution', 'fail'].includes(verdict.type);
const evidenceItems = Array.isArray(verdict.evidence) ? verdict.evidence : [];
const nextAction = d.nextAction && (d.nextAction.label || d.nextAction.detail) ? d.nextAction : null;
const nextActionHeading = nextAction && (['decision', 'stop'].includes(nextAction.kind) || /^停止/.test(nextAction.label || '')) ? '研究决策' : '下一步';
const verdictBlock = (verdict.headline || verdict.detail || evidenceItems.length || nextAction) ? `
  <section class="verdict-panel ${verdictIsRisk ? 'overfit' : ''}">
    <div class="verdict-top">
      <div>
        <div class="sub">研究结论</div>
        ${verdict.headline ? `<div class="verdict-title">${esc(verdict.headline)}</div>` : ''}
      </div>
      ${verdict.type ? `<span class="chip ${verdictIsRisk ? 'risk' : 'ok'}">${esc(verdictLabel(verdict.type))}</span>` : ''}
    </div>
    ${evidenceItems.length ? `<dl class="evidence-grid" aria-label="关键结论依据">${evidenceItems.map(i => `
      <div class="evidence-item evidence-${esc(i.status || 'note')}">
        <dt class="evidence-label">${esc(i.label)}</dt>
        <dd class="evidence-value">${esc(i.value)}</dd>
        ${i.meta ? `<dd class="evidence-meta">${esc(i.meta)}</dd>` : ''}
      </div>`).join('')}</dl>` : ''}
    ${verdict.detail ? `<details class="verdict-detail-fold"><summary>查看结论依据</summary><p class="verdict-detail">${esc(verdict.detail)}</p></details>` : ''}
    ${nextAction ? `<div class="next-action"><span>${nextActionHeading}</span><strong>${esc(nextAction.label || '继续研究')}</strong>${nextAction.detail ? `<p>${esc(nextAction.detail)}</p>` : ''}</div>` : ''}
  </section>` : '';

// —— Backtest screenshot（真实截图，替换 v0 的假 SVG 净值曲线）——
const shotCap = [d.scope || [d.symbol, d.timeframe].filter(Boolean).join(' · '), d.beforeAfter?.after?.params].filter(Boolean).map(esc).join(' · ');
const shotBlock = shotImg ? `
  <section>
    <h2 class="sec-h">${esc(d.screenshotTitle || '指标与交易信号')} <span class="sec-sub">${esc(d.screenshotLabel || 'TradingView · 本次回测')}</span></h2>
    <div class="shotwrap" id="proof-shot">${shotImg}</div>
    <div class="shot-meta">
      ${shotCap ? `<div class="shot-cap">${shotCap}</div>` : '<span></span>'}
      <button class="shot-toggle" type="button" aria-expanded="false" aria-controls="proof-shot" onclick="toggleShot(this)">查看完整截图</button>
    </div>
  </section>` : '';

// —— Before / After ——
let baBlock = '';
if (d.beforeAfter && d.beforeAfter.before && d.beforeAfter.after) {
  const a = d.beforeAfter.before, b = d.beforeAfter.after;
  const box = (c, hl) => `<div class="ba-box${hl ? ' hl' : ''}"><div class="ba-tag">${hl ? '调参后' : '原版'}</div><div class="ba-params">${esc(c.params || '')}</div><div class="ba-ret ${sgn(c.ret)}">${pct(c.ret)}</div><div class="ba-meta">回撤 ${mag(c.dd)} · ${esc(c.trades ?? '—')} 笔</div></div>`;
  baBlock = `
  <section>
    <h2 class="sec-h">原版 → 调参后</h2>
    <div class="ba">${box(a, false)}<div class="ba-arrow">→</div>${box(b, true)}</div>
  </section>`;
}

// —— Explain ——
const ex = d.explain || {};
const specLabels = {
  observation: '观察', entry: '入场', exit: '出场', position: '仓位', execution: '执行时点', costs: '交易成本', exclusions: '明确不做',
};
const strategySpecRows = Object.entries(specLabels)
  .map(([key, label]) => ({ key, label, value: d.strategySpec?.[key] || (key === 'costs' && d.costs ? [d.costs.commission && `手续费 ${d.costs.commission}`, d.costs.slippage && `滑点 ${d.costs.slippage}`].filter(Boolean).join(' · ') : '') }))
  .filter(({ value }) => value);
const modifiers = Array.isArray(d.strategySpec?.modifiers) ? d.strategySpec.modifiers.filter(i => i && (i.name || i.rule)) : [];
const modifierHtml = modifiers.length ? `<div class="spec-modifiers"><div class="spec-label">可选条件</div>${modifiers.map(i => `
  <div class="modifier-row"><div><span class="modifier-name">${esc(i.name || '附加条件')}</span>${i.default ? `<span class="chip warn">默认${esc(i.default)}</span>` : ''}</div><div class="modifier-rule">${esc(i.rule || '')}${i.role ? `<span class="modifier-role">${esc(i.role)}</span>` : ''}</div></div>`).join('')}</div>` : '';
const strategySpecHtml = (strategySpecRows.length || modifiers.length) ? `<div class="strategy-spec content-group"><div class="sub">Strategy Spec</div><div class="spec-grid">${strategySpecRows.map(({ key, label, value }) => `
  <div class="spec-item spec-${esc(key)}"><div class="spec-label">${esc(label)}</div><div class="spec-value">${esc(value)}</div></div>`).join('')}</div>${modifierHtml}</div>` : '';
const flow = Array.isArray(ex.flow) ? ex.flow.filter(i => i && (typeof i === 'string' || i.text)) : [];
const flowHtml = flow.length ? `<div class="seg content-group"><div class="sub">信号形成</div><ol class="signal-flow">${flow.map((step, i) => {
  const label = typeof step === 'string' ? `步骤 ${i + 1}` : (step.label || `步骤 ${i + 1}`);
  const value = typeof step === 'string' ? step : step.text;
  return `<li><span class="flow-label">${esc(label)}</span><span class="flow-text">${esc(value)}</span></li>`;
}).join('')}</ol></div>` : '';
const timeline = Array.isArray(ex.timeline) ? ex.timeline.filter(Boolean) : [];
const timelineHtml = timeline.length ? `<div class="seg content-group"><div class="sub">信号形成</div><ol class="timeline">${timeline.map((step, i) => `
  <li><span class="timeline-num">${i + 1}</span><span>${esc(step)}</span></li>`).join('')}</ol></div>` : '';
const optionalFilter = ex.optionalFilter;
const optionalFilterHtml = optionalFilter ? `<div class="seg optional-filter">
  <div class="optional-filter-head"><span class="sub">可选过滤器</span><span class="chip warn">默认${esc(optionalFilter.default || '关闭')}</span></div>
  <div class="optional-filter-title">${esc(optionalFilter.label || '过滤条件')}</div>
  <div class="optional-filter-rule">${esc(optionalFilter.rule || '')}</div>
  ${optionalFilter.limitation ? `<div class="optional-filter-note">${esc(optionalFilter.limitation)}</div>` : ''}
</div>` : '';
const structuredExplain = [
  ['信号是什么', ex.signal],
  ['何时确认', ex.confirmation],
  ['代理指标', ex.proxy],
].filter(([, value]) => value);
const structuredExplainHtml = structuredExplain.length ? `<div class="explain-steps">${structuredExplain.map(([label, value]) => `
  <div class="explain-step"><div class="explain-step-label">${esc(label)}</div><div class="explain-step-text">${esc(value)}</div></div>`).join('')}</div>` : '';
const readerGuide = Array.isArray(ex.readerGuide) ? ex.readerGuide.filter(i => i && (i.label || i.text)) : [];
const readerGuideHtml = readerGuide.length ? `<div class="reader-guide content-group"><div class="sub">先看懂它</div><dl>${readerGuide.map(i => `
  <div class="reader-guide-row"><dt>${esc(i.label || '关键概念')}</dt><dd>${esc(i.text || '')}</dd></div>`).join('')}</dl></div>` : '';
const codeEvidence = Array.isArray(d.codeEvidence) ? d.codeEvidence.filter(i => i && i.code) : [];
const paramsList = (ex.params || []).map(p => {
  const isKey = ex.keyParam && p.name === ex.keyParam;
  return `<li><span class="pname${isKey ? ' key' : ''}">${esc(p.name)}${isKey ? '<span class="kflag">关键</span>' : ''}</span><span class="peff">${esc(p.effect)}</span></li>`;
}).join('');
const keyParams = Array.isArray(ex.keyParams) ? ex.keyParams.filter(p => p && (p.name || p.effect)) : [];
const usageHtml = (ex.edge || keyParams.length || ex.worksWhen || ex.failsWhen) ? `<div class="seg usage content-group"><div class="sub">如何使用</div>
  ${ex.edge ? `<div class="usage-edge"><span>核心假设</span>${esc(ex.edge)}</div>` : ''}
  ${keyParams.length ? `<div class="usage-params">${keyParams.map(p => `<div><strong>${esc(p.name || '关键参数')}</strong><span>${esc(p.effect || '')}</span></div>`).join('')}</div>` : ''}
  ${(ex.worksWhen || ex.failsWhen) ? `<div class="usage-scenes">${ex.worksWhen ? `<div><span>更适合</span>${esc(ex.worksWhen)}</div>` : ''}${ex.failsWhen ? `<div><span>要小心</span>${esc(ex.failsWhen)}</div>` : ''}</div>` : ''}
</div>` : '';
const deep = ex.deep || {};
const deepVariables = Array.isArray(deep.variables) ? deep.variables.filter(v => v && (v.symbol || v.meaning)) : [];
const deepEquations = Array.isArray(deep.equations) ? deep.equations.filter(item => item && (item.label || item.expression)) : [];
const equationsHtml = deepEquations.length ? `<div class="equation-list">${deepEquations.map(item => `
  <div class="equation-item">
    <div class="equation-label">${esc(item.label || '公式')}</div>
    <div class="equation-expression">${esc(item.expression || '')}</div>
    ${item.note ? `<div class="equation-note">${esc(item.note)}</div>` : ''}
  </div>`).join('')}</div>` : '';
const variablesHtml = deepVariables.length ? `<dl class="variable-list">${deepVariables.map(v => `<div><dt>${esc(v.symbol || '')}</dt><dd>${esc(v.meaning || '')}</dd></div>`).join('')}</dl>` : '';
const mathConceptHtml = deepEquations.length ? `<div class="math-concept-grid">
  <div class="math-equations"><div class="detail-label">核心公式</div>${equationsHtml}</div>
  <div class="math-variables"><div class="detail-label">符号说明</div>${variablesHtml}</div>
</div>` : '';
const usesAdaptiveExplain = readerGuide.length || flow.length || keyParams.length || modifiers.length || Object.keys(deep).length;
const hasDeep = deep.intuition || deepVariables.length || deepEquations.length || deep.example || deep.formula || deep.derivation
  || ex.example || ex.formula || ex.derivation || paramsList || codeEvidence.length || ex.repaintNote;
const deepHtml = hasDeep ? `<details class="derive seg deep-detail"${deep.open ? ' open' : ''}><summary><span>深入理解这个指标</span></summary><div class="deep-detail-body">
  ${deep.intuition ? `<div class="detail-label">先用直觉理解</div><p class="detail-example">${esc(deep.intuition)}</p>` : ''}
  ${mathConceptHtml || (deepVariables.length ? `<div class="detail-label">符号说明</div>${variablesHtml}` : '')}
  ${(deep.example || ex.example) ? `<div class="detail-example-box"><div class="detail-label">计算示例</div><p class="detail-example math-example">${esc(deep.example || ex.example)}</p></div>` : ''}
  ${!deepEquations.length && (deep.formula || ex.formula) ? `<div class="detail-label">公式</div><pre class="formula">${esc(deep.formula || ex.formula)}</pre>` : ''}
  ${(deep.derivation || ex.derivation) ? `<div class="detail-label">推导</div><p class="detail-example">${esc(deep.derivation || ex.derivation)}</p>` : ''}
  ${paramsList ? `<div class="detail-label">参数影响</div><ul class="params params-soft">${paramsList}</ul>` : ''}
  ${codeEvidence.length ? `<div class="detail-label">关键代码</div><div class="code-evidence-body">${codeEvidence.map(i => `<figure class="code-evidence-item"><figcaption class="code-evidence-head"><span class="code-evidence-title">${esc(i.title || '关键逻辑')}</span><span class="code-evidence-lang">Pine Script</span></figcaption><pre class="code-evidence-code"><code>${esc(i.code)}</code></pre>${i.explanation ? `<p class="code-evidence-note">${esc(i.explanation)}</p>` : ''}</figure>`).join('')}</div>` : ''}
  ${ex.repaintNote ? `<div class="detail-label">重绘与未来函数检查</div><p class="detail-example">${esc(ex.repaintNote)}</p>` : ''}
</div></details>` : '';
const isOverfit = (d.verdict || {}).type === 'overfit';
const explainPlain = [
  ex.howItWorks,
  ...readerGuide.map(i => `【${i.label || '关键概念'}】${i.text || ''}`),
  ...strategySpecRows.map(({ label, value }) => `【${label}】${value}`),
  ...modifiers.map(i => `【可选条件】${i.name || ''}${i.default ? `（默认${i.default}）` : ''}：${i.rule || ''}${i.role ? `；${i.role}` : ''}`),
  flow.length ? '【信号形成】\n' + flow.map((step, i) => `${i + 1}. ${typeof step === 'string' ? step : `${step.label || '步骤'}：${step.text}`}`).join('\n') : '',
  timeline.length ? '【信号形成】' + timeline.map((step, i) => `${i + 1}. ${step}`).join(' → ') : '',
  optionalFilter ? `【可选过滤器】默认${optionalFilter.default || '关闭'}；${optionalFilter.rule || ''}；${optionalFilter.limitation || ''}` : '',
  ...structuredExplain.map(([label, value]) => `【${label}】${value}`),
  ex.formula ? '【数学原理】\n' + ex.formula : '',
  ex.derivation ? '【数学推导】\n' + ex.derivation : '',
  ex.example ? '【计算示例】\n' + ex.example : '',
  ex.edge ? '【核心假设】' + ex.edge : '',
  keyParams.length ? '【关键参数】\n' + keyParams.map(p => `· ${p.name}：${p.effect}`).join('\n') : '',
  deep.intuition ? '【直觉理解】' + deep.intuition : '',
  deepVariables.length ? '【符号说明】\n' + deepVariables.map(v => `${v.symbol}：${v.meaning}`).join('\n') : '',
  deepEquations.length ? '【核心公式】\n' + deepEquations.map(item => `${item.label || '公式'}：${item.expression || ''}${item.note ? `\n${item.note}` : ''}`).join('\n') : '',
  deep.example ? '【计算示例】\n' + deep.example : '',
  !deepEquations.length && deep.formula ? '【数学原理】\n' + deep.formula : '',
  deep.derivation ? '【数学推导】\n' + deep.derivation : '',
  (ex.params || []).length ? '【参数影响】\n' + ex.params.map(p => `· ${p.name}：${p.effect}`).join('\n') : '',
  ex.worksWhen ? '【有效场景】' + ex.worksWhen : '',
  ex.failsWhen ? '【失效场景】' + ex.failsWhen : '',
  ex.repaintNote ? '【重绘检查】' + ex.repaintNote : '',
  ...codeEvidence.map(i => `【${i.title || '代码证据'}】\n${i.code}${i.explanation ? '\n' + i.explanation : ''}`),
].filter(Boolean).join('\n\n');
const explainBlock = Object.keys(ex).length ? `
  <section>
    <div class="sec-h-row"><h2 class="sec-h nomb">指标讲解</h2><button class="iconbtn" type="button" title="复制讲解" aria-label="复制讲解" onclick="doCopy(this,'.explain-plain')">${copySvg}</button></div>
    <pre class="explain-plain" hidden>${esc(explainPlain)}</pre>
    <div class="vspace">
      ${ex.howItWorks ? `<p class="para">${esc(ex.howItWorks)}</p>` : ''}
      ${readerGuideHtml}
      ${strategySpecHtml}
      ${flowHtml}
      ${timelineHtml}
      ${structuredExplainHtml}
      ${optionalFilterHtml}
      ${usageHtml}
      ${deepHtml}
      ${!usesAdaptiveExplain && (ex.worksWhen || ex.failsWhen) ? `<div class="seg callouts">
        ${ex.worksWhen ? `<div class="co"><div class="co-lab">有效场景</div><div class="co-txt">${esc(ex.worksWhen)}</div></div>` : ''}
        ${ex.failsWhen ? `<div class="co"><div class="co-lab">失效场景</div><div class="co-txt muted">${esc(ex.failsWhen)}</div></div>` : ''}
      </div>` : ''}
      ${!usesAdaptiveExplain ? `<div class="seg tags">
        <div class="tagrow">
          <span class="tk">重绘检查</span>
          ${ex.repaint === 'sanitized'
            ? `<span class="chip warn">已净化</span>`
            : `<span class="chip ok">不重绘</span>`}
          <span class="tnote">${esc(ex.repaintNote || '')}</span>
        </div>
        ${isOverfit ? `<div class="tagrow">
          <span class="tk">过拟合</span>
          <span class="chip risk">高风险</span>
          <span class="tnote">${esc((d.verdict || {}).detail || '')}</span>
        </div>` : ''}
      </div>` : ''}
    </div>
  </section>` : '';

// —— 指标源码（默认仅保留紧凑折叠行；来源审计说明按需显示）——
let srcBlock = '';
if (d.source) {
  const showSourceAttribution = d.showSourceAttribution === true;
  const label = esc(d.sourceLabel || '完整策略源码');
  const description = esc(d.sourceDescription || '完整 Pine 策略用于审阅入场、出场、仓位、执行时点与交易成本。');
  srcBlock = `
  <section class="source-section">
    ${showSourceAttribution ? `<h2 class="sec-h src-heading">${label}</h2><p class="src-desc">${description}</p>` : ''}
    <details class="src">
      <summary><span class="src-open">${showSourceAttribution ? '展开完整源码' : '查看策略源码'}</span><span class="src-close">收起策略源码</span><span class="src-hint">Pine Script</span></summary>
      <div class="codewrap">
        <button class="copybtn iconbtn" type="button" title="复制代码" aria-label="复制代码" onclick="doCopy(this,'pre.code')">${copySvg}</button>
        <pre class="code">${esc(d.source)}</pre>
      </div>
    </details>
  </section>`;
}

function renderAlphaBars(rows, className = '') {
  const alphaOf = (r) => r.alpha ?? r.alpha_pct;
  const maxAbs = Math.max(1, ...rows.map(r => Math.abs(num(alphaOf(r)) || 0)));
  return rows.map(r => {
    const alpha = num(alphaOf(r)) || 0;
    const positive = alpha >= 0;
    const width = (Math.abs(alpha) / maxAbs) * 50;
    const bar = positive
      ? `<div class="bar-side right"><span class="bar pos" style="width:${width.toFixed(1)}%"></span></div>`
      : `<div class="bar-side left"><span class="bar neg" style="width:${width.toFixed(1)}%"></span></div>`;
    return `<div class="bar-row">
      <span class="bar-sym">${esc(marketLabel(r.symbol))}</span>
      <div class="bar-track"><span class="bar-mid"></span>${bar}</div>
      <span class="bar-val ${sgn(alpha)}">${pct(alpha)}</span>
    </div>`;
  }).join('');
}

// —— Robustness ——
let robustBlock = '';
if (d.robustness && Array.isArray(d.robustness.rows)) {
  const R = d.robustness.rows;
  const alphaOf = (r) => r.alpha ?? r.alpha_pct;
  const stratOf = (r) => r.strat ?? r.strategy_pct;
  const bhOf = (r) => r.bh ?? r.bh_pct;
  const barsHtml = renderAlphaBars(R);
  const rows = R.map(r => `
      <tr>
        <td class="sym">${esc(marketLabel(r.symbol))}${r.range ? `<small class="market-range">${esc(r.range)}</small>` : ''}</td>
        <td class="${sgn(stratOf(r))}">${pct(stratOf(r))}</td>
        <td class="muted">${pct(bhOf(r))}</td>
        <td class="${sgn(alphaOf(r))} big">${pct(alphaOf(r))}</td>
        <td class="muted">${esc(r.trades ?? '—')}${r.pf != null ? `<small class="market-range">PF ${esc(num(r.pf).toFixed(2))}</small>` : ''}</td>
        <td>${num(alphaOf(r)) > 0 ? '<span class="chip ok sm">赢</span>' : '<span class="chip dstr sm">输</span>'}</td>
      </tr>`).join('');
  robustBlock = `
  <section>
    <div class="sec-h-row"><h2 class="sec-h nomb">同参三市场验证</h2><span class="beat">跑赢 ${esc(d.robustness.beatBh || '')}</span></div>
    <div class="barwrap">
      <div class="chart-cap">各市场超额收益 α（&gt;0 才跑赢 B&amp;H；红条 = 未跑赢）</div>
      <div class="barchart">${barsHtml}</div>
    </div>
    <div class="table-scroll"><table class="grid">
      <thead><tr><th>市场</th><th>策略</th><th>B&amp;H</th><th>α</th><th>交易</th><th>结果</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

// —— 参数敏感性热力图（手写 SVG，α/收益可切换，最优格描边，悬停浮层）——
const heatBlock = (() => {
  const hm = d.heatmap;
  if (!hm || !Array.isArray(hm.cells) || !hm.cells.length) return '';
  const heatEvaluation = evaluationView({
    evaluation: hm.evaluation || d.evaluation || (hm.comparisonStatus ? { comparisonStatus: hm.comparisonStatus } : null),
  });
  const allowAlpha = heatEvaluation.allowCandidateAlpha && hm.allowAlpha !== false;
  const xs = hm.xParam.values, ys = hm.yParam.values;
  const cellW = 180, cellH = 64, gap = 8, padL = 82, padT = 10, padB = 42, padR = 8;
  const W = padL + xs.length * cellW + padR, H = padT + ys.length * cellH + padB;
  const at = (x, y) => hm.cells.find(c => c.x === x && c.y === y);
  const vals = (m) => hm.cells.map(c => c[m]).filter(v => v != null && isFinite(v));
  const colorFor = (c, m) => {
    if (!c || c[m] == null) return '#f4f4f5';
    const value = Number(c[m]);
    const mx = Math.max(1, ...vals(m).map(Math.abs));
    const t = Math.min(1, Math.abs(value) / mx);
    return (value >= 0 ? 'rgba(5,150,105,' : 'rgba(239,68,68,') + (0.10 + 0.76 * t).toFixed(3) + ')';
  };
  const textColorFor = (c, m) => {
    if (!c || c[m] == null) return '#a1a1aa';
    const mx = Math.max(1, ...vals(m).map(Math.abs));
    return Math.abs(Number(c[m])) / mx > 0.52 ? '#ffffff' : '#3f3f46';
  };
  const labelFor = (c, m) => c?.[m] == null ? '—' : `${Number(c[m]) > 0 ? '+' : ''}${Number(c[m]).toFixed(1)}%`;
  const dm = allowAlpha && hm.metric !== 'ret' ? 'alpha' : 'ret';
  const cellParts = ys.map((y, yi) => xs.map((x, xi) => {
    const c = at(x, y), isBest = hm.best && x === hm.best.x && y === hm.best.y;
    const px = padL + xi * cellW, py = padT + yi * cellH;
    const ca = colorFor(c, 'alpha'), cr = colorFor(c, 'ret');
    const ta = textColorFor(c, 'alpha'), tr = textColorFor(c, 'ret');
    const alphaTip = allowAlpha ? ` · α ${c?.alpha == null ? '—' : c.alpha + '%'}` : '';
    const tip = c ? `${hm.xParam.name}=${x}, ${hm.yParam.name}=${y} · 收益 ${c.ret == null ? '—' : c.ret + '%'}${alphaTip} · ${c.trades == null ? '—' : c.trades} 笔 · PF ${c.pf}` : '';
    return `<rect class="hm-cell${isBest ? ' hm-best' : ''}" x="${px}" y="${py}" width="${cellW - gap}" height="${cellH - gap}" rx="4" fill="${dm === 'alpha' ? ca : cr}" data-fill-alpha="${ca}" data-fill-ret="${cr}" data-tip="${esc(tip)}"/>
      <text class="hm-value" x="${px + (cellW - gap) / 2}" y="${py + (cellH - gap) / 2 + 5}" text-anchor="middle" fill="${dm === 'alpha' ? ta : tr}" data-label-alpha="${labelFor(c, 'alpha')}" data-label-ret="${labelFor(c, 'ret')}" data-color-alpha="${ta}" data-color-ret="${tr}">${labelFor(c, dm)}</text>`;
  }).join('')).join('');
  const xlab = xs.map((x, xi) => `<text x="${padL + xi * cellW + (cellW - gap) / 2}" y="${padT + ys.length * cellH + 22}" text-anchor="middle" font-size="13" fill="#71717a">${esc(x)}</text>`).join('');
  const ylab = ys.map((y, yi) => `<text x="${padL - 12}" y="${padT + yi * cellH + (cellH - gap) / 2 + 5}" text-anchor="end" font-size="13" fill="#71717a">${esc(y)}</text>`).join('');
  const cyMid = padT + ys.length * cellH / 2;
  const svg = `<svg class="heatmap-svg" data-metric="${dm}" viewBox="0 0 ${W} ${H}" width="100%">${cellParts}${xlab}${ylab}<text x="${padL + xs.length * cellW / 2}" y="${H - 5}" text-anchor="middle" font-size="13" fill="#a1a1aa">${esc(hm.xParam.name)} →</text><text x="16" y="${cyMid}" text-anchor="middle" font-size="13" fill="#a1a1aa" transform="rotate(-90 16 ${cyMid})">${esc(hm.yParam.name)} →</text></svg>`;
  const fixedNote = hm.fixed?.length ? `<span class="hm-fixed">其余固定：${hm.fixed.map(f => esc(f.name + '=' + f.value)).join('、')}</span>` : '';
  const toggle = allowAlpha ? `<div class="hm-toggle" data-metric-toggle><button type="button" class="${dm === 'alpha' ? 'on' : ''}" data-m="alpha" onclick="hmToggle(this,'alpha')">α 超额</button><button type="button" class="${dm === 'ret' ? 'on' : ''}" data-m="ret" onclick="hmToggle(this,'ret')">总收益</button></div>` : '';
  const comparisonNote = hm.comparisonNote || '';
  const dimensions = numberValue(hm.searchedDimensions) ?? numberValue(d.optimization?.axes?.length) ?? 2;
  const matrixNote = dimensions > 2
    ? `本次共搜索 ${dimensions} 个参数；矩阵固定其余参数，只展示 Top-1 所在的二维切片。`
    : `本次搜索 ${dimensions} 个参数，共 ${hm.cells.length} 格。`;
  return `
  <section class="optimization-heatmap">
    <div class="sec-h-row"><h3 class="subsection-title">参数敏感性</h3>${toggle}</div>
    <div class="chart-cap">${esc(matrixNote)} 当前目标格描边高亮；孤立亮格要谨慎，成片区域更稳定。${fixedNote}${comparisonNote ? `<br>${esc(comparisonNote)}` : ''}</div>
    <div class="hm-wrap" onmousemove="hmMove(event)" onmouseleave="hmHide()">
      <div class="hm-panel">${svg}</div>
      <div class="hm-tip" hidden></div>
    </div>
  </section>`;
})();

// —— P2 深度优化：Top-K + 形状结论（不替代热力图，只补证据）——
const paramsText = (params = {}) => Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' · ');
const objectiveLabel = (value) => ({
  risk_adjusted: '收益 / 回撤',
  net_pnl: '策略收益',
  profit_factor: '盈亏比 PF',
  alpha: '相对 B&H',
  win_rate_confidence: '胜率置信下界',
}[value] || value || '研究目标');
const optBlock = (() => {
  const opt = d.optimization;
  if (!opt) return '';
  const axes = Array.isArray(opt.axes) ? opt.axes : [];
  const axisText = axes.map(a => `${a.name}: ${(a.values || []).join(', ')}`).join('；');
  const rows = Array.isArray(opt.top) ? opt.top : [];
  const heatmapCells = Array.isArray(d.heatmap?.cells) ? d.heatmap.cells : [];
  const heatmapX = d.heatmap?.xParam?.name;
  const heatmapY = d.heatmap?.yParam?.name;
  const metricForRow = (row, key) => {
    const direct = numberValue(row?.[key]);
    if (direct != null) return direct;
    const match = heatmapCells.find(cell => {
      const xMatches = !heatmapX || String(row?.params?.[heatmapX]) === String(cell.x);
      const yMatches = !heatmapY || String(row?.params?.[heatmapY]) === String(cell.y);
      return xMatches && yMatches;
    });
    return numberValue(match?.[key]);
  };
  const topRows = rows.length ? rows.map(r => `
      <tr>
        <td class="sym">#${esc(r.rank ?? '')}</td>
        <td class="muted p2-param">${esc(paramsText(r.params))}</td>
        <td class="${sgn(r.ret)}">${pct(r.ret)}</td>
        <td class="muted">${metricForRow(r, 'pf') == null ? '—' : esc(metricForRow(r, 'pf').toFixed(2))}</td>
        <td class="muted">${esc(r.trades ?? '—')}</td>
      </tr>`).join('') : `
      <tr><td colspan="5" class="muted">暂无有效候选。</td></tr>`;
  const searchScope = opt.scope || [marketLabel(d.symbol), d.timeframe].filter(Boolean).join(' · ');
  return `
  <section class="optimization-ranking">
    <div class="sec-h-row"><h3 class="subsection-title">候选排名</h3><span class="muted">预算 ${esc(opt.budget ?? '—')}</span></div>
    <div class="p2-line">
      ${searchScope ? `<span class="p2-scope">搜索市场：${esc(searchScope)}</span>` : ''}
      <span class="p2-objective">目标：${esc(objectiveLabel(opt.effectiveObjective || opt.effective_objective || opt.objective))}</span>
      ${opt.evaluated != null ? `<span class="muted">已评估 ${esc(opt.evaluated)} 组</span>` : ''}
    </div>
    ${axisText ? `<div class="chart-cap">${esc(axisText)}</div>` : ''}
    ${opt.shape?.verdict ? `<div class="p2-verdict">${esc(opt.shape.verdict)}</div>` : ''}
    <div class="sub">本次参数组合</div>
    <div class="table-scroll"><table class="grid optimization-table">
      <thead><tr><th>排名</th><th>参数</th><th>策略收益</th><th>PF</th><th>交易</th></tr></thead>
      <tbody>${topRows}</tbody>
    </table></div>
  </section>`;
})();

const optimizationDetailBlock = (() => {
  if (!heatBlock && !optBlock) return '';
  const axes = Array.isArray(d.optimization?.axes) ? d.optimization.axes : [];
  const dimensions = numberValue(d.heatmap?.searchedDimensions) ?? axes.length ?? 0;
  const plannedGrid = axes.length && axes.every(axis => Array.isArray(axis.values) && axis.values.length)
    ? axes.reduce((total, axis) => total * axis.values.length, 1)
    : null;
  const evaluated = numberValue(d.optimization?.evaluated) ?? numberValue(d.heatmap?.cells?.length) ?? plannedGrid;
  const summaryMeta = [dimensions ? `${dimensions} 个参数` : '', evaluated != null ? `${evaluated} 格` : ''].filter(Boolean).join(' · ');
  return `<details class="research-detail" open>
    <summary><span>深度优化</span>${summaryMeta ? `<small>${esc(summaryMeta)}</small>` : ''}</summary>
    <div class="research-detail-body">${heatBlock}${optBlock}</div>
  </details>`;
})();

// —— P2 验证：多市场/近似验证单独展示，不覆盖 scan 证据 ——
const validationBlock = (() => {
  const v = d.validation;
  if (!v) return '';
  const rows = Array.isArray(v.rows) ? v.rows : [];
  const robustnessRows = Array.isArray(d.robustness?.rows) ? d.robustness.rows : [];
  const sameNumber = (a, b) => {
    const na = numberValue(a), nb = numberValue(b);
    return na == null && nb == null || (na != null && nb != null && Math.abs(na - nb) < 0.01);
  };
  const duplicatesRobustness = rows.length > 0 && rows.length === robustnessRows.length && rows.every((row) => {
    const robust = robustnessRows.find(candidate => marketKey(candidate.symbol) === marketKey(row.symbol));
    return robust
      && sameNumber(row.strategy ?? row.strategy_pct ?? row.ret, robust.strat ?? robust.strategy_pct)
      && sameNumber(row.bh ?? row.bh_pct, robust.bh ?? robust.bh_pct)
      && sameNumber(row.alpha ?? row.alpha_pct, robust.alpha ?? robust.alpha_pct)
      && sameNumber(row.trades, robust.trades);
  });
  if (duplicatesRobustness) return '';
  const barsHtml = renderAlphaBars(rows);
  const tableRows = rows.length ? rows.map(r => {
    const alpha = r.alpha ?? r.alpha_pct;
    const strategy = r.strategy ?? r.strategy_pct ?? r.ret;
    const bh = r.bh ?? r.bh_pct;
    return `
      <tr>
        <td class="sym">${esc(marketLabel(r.symbol))}</td>
        <td class="${sgn(strategy)}">${pct(strategy)}</td>
        <td class="muted">${pct(bh)}</td>
        <td class="${sgn(alpha)} big">${pct(alpha)}</td>
        <td class="muted">${esc(r.trades ?? '—')}</td>
        <td>${alpha > 0 ? '<span class="chip ok sm">赢</span>' : '<span class="chip dstr sm">输</span>'}</td>
      </tr>`;
  }).join('') : '<tr><td colspan="6" class="muted">暂无验证行。</td></tr>';
  return `
  <section>
    <div class="sec-h-row"><h2 class="sec-h nomb">P2 验证</h2><span class="beat">跑赢 ${esc(v.beatBh || '')}</span></div>
    ${v.verdict?.label ? `<div class="p2-verdict">${esc(v.verdict.label)}${v.verdict.detail ? '：' + esc(v.verdict.detail) : ''}</div>` : ''}
    ${rows.length ? `<div class="barwrap"><div class="chart-cap">各市场超额收益 α（红条向左表示落后 B&amp;H）</div><div class="barchart validation-bars">${barsHtml}</div></div>` : ''}
    <div class="table-scroll"><table class="grid">
      <thead><tr><th>市场</th><th>策略</th><th>B&amp;H</th><th>α</th><th>交易</th><th>结果</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table></div>
  </section>`;
})();

// —— OOS / Walk-forward：仅渲染已有证据；unavailable 明确标注 ——
const oosBlock = (() => {
  const o = d.oos;
  if (!o || o.status === 'unavailable') return '';
  const cell = (label, x) => `<div class="oos-col"><div class="s-lab">${esc(label)}</div>
    <div class="oos-main ${sgn(x?.ret)}">${pct(x?.ret)}</div>
    <div class="s-sub">α ${pct(x?.alpha)} · 回撤 ${mag(x?.dd)} · ${esc(x?.trades ?? '—')} 笔</div></div>`;
  return `
  <section>
    <div class="sec-h-row"><h2 class="sec-h nomb">OOS / Walk-forward</h2><span class="source-tag">${esc(o.status || 'unknown')}</span></div>
    <div class="p2-line"><span class="muted">${esc(o.method || '')}</span></div>
    ${(o.train || o.test) ? `<div class="oos-cols">${cell('训练段', o.train)}${cell('测试段', o.test)}</div>` : ''}
    ${o.decay ? `<div class="p2-verdict">衰减：收益 ${pct(o.decay.ret_pct)} · α ${pct(o.decay.alpha_pct)}。${esc(o.decay.verdict || '')}</div>` : `<div class="p2-verdict">${esc(o.verdict || '未提供样本外证据。')}</div>`}
  </section>`;
})();

// 组装：header → stats → 紧邻的研究结论 → 其余长内容。
const sections = [
  { html: shotBlock },
  { html: baBlock },
  { html: explainBlock },
  { html: srcBlock, compact: true },
  { html: optimizationDetailBlock, compact: true },
  { html: validationBlock },
  { html: robustBlock },
  { html: oosBlock },
].filter(section => section.html);
const rule = '<hr class="rule"/>';
const body = statRow + costBlock + verdictBlock + sections
  .map(section => `<hr class="rule${section.compact ? ' compact-rule' : ''}"/>${section.html}`)
  .join('') + rule;

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"/>
<meta name="tv-indicator-report-template" content="${REPORT_TEMPLATE_VERSION}"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(d.title || '指标评估报告')}</title>
<style>
  /* === 白底文档式报告：留白分区，内容组使用轻底色（zinc palette + emerald/red） === */
  :root{
    --bg:#ffffff; --z50:#fafafa; --z100:#f4f4f5; --z200:#e4e4e7; --z300:#d4d4d8;
    --z400:#a1a1aa; --z500:#71717a; --z600:#52525b; --z700:#3f3f46; --z800:#27272a; --z900:#18181b;
    --pos:#059669; --pos2:#10b981; --posBg:#ecfdf5; --posBd:#d1fae5; --posFg:#047857;
    --neg:#ef4444; --neg2:#f87171; --negBg:#fef2f2; --negBd:#fee2e2; --negFg:#dc2626;
    --warnBg:#fffbeb; --warnBd:#fef3c7; --warnFg:#b45309;
    --panel:#fdfdfd; --font:"Inter",-apple-system,system-ui,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
    --mono:"SF Mono","Cascadia Code",ui-monospace,Consolas,"PingFang SC","Microsoft YaHei",monospace;
  }
  *{ box-sizing:border-box; margin:0; padding:0; }
  body{ background:var(--bg); color:var(--z900); line-height:1.5; font-family:var(--font);
    -webkit-font-smoothing:antialiased; font-size:14px; }
  .wrap{ --page-pad:16px; max-width:672px; margin:0 auto; padding:40px var(--page-pad); }
  hr.rule{ height:0; border:0; margin:34px 0; }
  hr.rule.compact-rule{ margin:12px 0; }
  section > .sec-h, section > .sec-h-row{ }
  /* header */
  .head{ margin-bottom:24px; }
  .report-utility{ min-height:32px; display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:12px; }
  .pills{ display:flex; flex-wrap:wrap; gap:8px; }
  .pill-t{ padding:2px 8px; border-radius:4px; background:var(--z100); color:var(--z500);
    font-size:11px; font-weight:500; }
  .report-actions{ flex:0 0 auto; display:flex; align-items:center; gap:2px; }
  .report-action{ min-height:28px; padding:0 8px; border:0; border-radius:5px; background:transparent;
    color:var(--z500); cursor:pointer; font:inherit; font-size:11px; font-weight:600; line-height:1; text-decoration:none;
    white-space:nowrap; display:inline-flex; align-items:center; justify-content:center; }
  .report-action:hover{ background:var(--z50); color:var(--z900); }
  .report-action:focus-visible{ outline:2px solid var(--z300); outline-offset:2px; }
  .htitle{ font-size:24px; font-weight:700; letter-spacing:-.3px; line-height:1.25; color:var(--z900); }
  .hone{ margin-top:8px; font-size:14px; line-height:1.7; color:var(--z500); }
  /* section header */
  .sec-h{ font-size:16px; font-weight:600; color:var(--z800); margin-bottom:20px; }
  .sec-h.nomb{ margin-bottom:0; }
  .sec-sub{ font-size:12px; font-weight:400; color:var(--z400); margin-left:8px; }
  .sec-h-row{ display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
  /* stat row（4 列竖线分隔） */
  .stats{ display:grid; grid-template-columns:repeat(4,1fr); }
  .stat{ padding:0 24px; } .stat:first-child{ padding-left:0; } .stat:last-child{ padding-right:0; }
  .stat + .stat{ border-left:1px solid var(--z100); }
  .s-lab{ font-size:11px; color:var(--z400); font-weight:500; letter-spacing:.4px; }
  .s-val{ font-size:24px; font-weight:700; margin-top:6px; font-variant-numeric:tabular-nums; line-height:1.15; }
  .s-val.plain{ color:var(--z700); }
  .s-sub{ font-size:11px; color:var(--z400); margin-top:2px; font-variant-numeric:tabular-nums; }
  .costline{ margin-top:18px; font-size:11px; line-height:1.6; color:var(--z400); }
  /* verdict evidence strip */
  .verdict-panel{ margin:24px 0 0; padding:18px var(--page-pad); border:0; border-radius:0; background:var(--z50); }
  .verdict-top{ display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
  .verdict-title{ max-width:520px; font-size:17px; line-height:1.45; font-weight:700; color:var(--z900); }
  .verdict-detail{ margin-top:14px; font-size:12px; line-height:1.75; color:var(--z500); }
  .verdict-detail-fold{ margin-top:14px; }
  .verdict-detail-fold > summary{ width:max-content; cursor:pointer; color:var(--z500); font-size:11px; font-weight:600; }
  .next-action{ margin-top:16px; padding-top:14px; border-top:1px solid var(--z100); display:grid; grid-template-columns:72px 1fr; gap:4px 12px; align-items:baseline; font-size:12px; line-height:1.65; }
  .next-action > span{ color:var(--z400); font-weight:600; }
  .next-action > strong{ color:var(--z700); font-weight:600; }
  .next-action > p{ grid-column:2; color:var(--z500); }
  .evidence-grid{ margin-top:16px; display:grid; grid-template-columns:repeat(3,1fr); gap:0; }
  .evidence-item{ min-width:0; padding:2px 16px 2px 0; }
  .evidence-item + .evidence-item{ padding-left:16px; border-left:1px solid var(--z100); }
  .evidence-label{ font-size:10px; color:var(--z400); font-weight:600; }
  .evidence-value{ margin-top:5px; font-size:13px; line-height:1.45; color:var(--z700); font-weight:700; }
  .evidence-meta{ margin-top:4px; font-size:10px; line-height:1.55; color:var(--z500); font-weight:500; }
  .evidence-fail .evidence-value{ color:var(--negFg); }
  .evidence-win .evidence-value{ color:var(--posFg); }
  /* backtest screenshot */
  .shotwrap{ aspect-ratio:16/9; border-radius:12px; overflow:hidden; border:1px solid var(--z100); background:#fff; }
  .shotwrap.is-full{ aspect-ratio:auto; }
  .shot{ width:100%; height:100%; display:block; object-fit:contain; object-position:center; }
  .shotwrap.is-full .shot{ height:auto; object-fit:contain; }
  .shot-meta{ margin-top:8px; display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
  .shot-cap{ font-size:11px; line-height:1.55; color:var(--z400); }
  .shot-toggle{ flex:0 0 auto; border:0; background:transparent; color:var(--z500); font:inherit; font-size:11px; font-weight:650; cursor:pointer; }
  .shot-toggle:hover{ color:var(--z800); }
  /* before/after */
  .ba{ display:flex; align-items:stretch; gap:12px; }
  .ba-box{ flex:1; border-radius:12px; padding:16px 16px 16px 0; background:transparent; }
  .ba-box.hl{ padding:16px; background:var(--z50); }
  .ba-tag{ font-size:11px; font-weight:600; color:var(--z400); letter-spacing:.5px; }
  .ba-box.hl .ba-tag{ color:var(--z500); }
  .ba-params{ font-size:12px; color:var(--z500); margin:8px 0 12px; min-height:32px; }
  .ba-ret{ font-size:24px; font-weight:700; font-variant-numeric:tabular-nums; }
  .ba-meta{ font-size:11px; color:var(--z400); margin-top:4px; }
  .ba-arrow{ align-self:center; color:var(--z300); font-size:18px; }
  /* explain */
  .vspace > *{ margin-top:20px; } .vspace > *:first-child{ margin-top:0; }
  .explain-steps{ display:flex; flex-direction:column; gap:14px; }
  .explain-step{ display:grid; grid-template-columns:76px 1fr; gap:14px; align-items:start; }
  .explain-step-label{ font-size:12px; font-weight:600; color:var(--z700); }
  .explain-step-text{ font-size:13px; line-height:1.7; color:var(--z600); }
  .reader-guide{ padding-top:14px; padding-bottom:14px; }
  .reader-guide > .sub{ margin-bottom:10px; }
  .reader-guide dl{ display:flex; flex-direction:column; }
  .reader-guide-row{ display:grid; grid-template-columns:96px 1fr; gap:12px; align-items:start; }
  .reader-guide-row + .reader-guide-row{ margin-top:10px; padding-top:10px; border-top:1px solid var(--z100); }
  .reader-guide dt{ color:var(--z700); font-size:12px; font-weight:700; }
  .reader-guide dd{ color:var(--z600); font-size:13px; line-height:1.65; }
  .seg{ padding-top:0; border-top:0; }
  .content-group{ margin-inline:0; padding:17px var(--page-pad); border:0; border-radius:0; background:var(--z50); }
  .reader-guide.content-group{ padding-block:14px; }
  .content-group > .sub{ margin-bottom:14px; color:var(--z700); font-size:13px; font-weight:700; }
  .spec-grid{ display:grid; grid-template-columns:1fr 1fr; gap:12px 24px; }
  .spec-item{ min-width:0; }
  .spec-observation{ grid-column:1 / -1; padding-bottom:12px; border-bottom:1px solid var(--z100); }
  .spec-label{ font-size:11px; font-weight:600; color:var(--z400); }
  .spec-value{ margin-top:3px; font-size:13px; line-height:1.6; color:var(--z700); }
  .spec-modifiers{ margin-top:14px; padding-top:12px; }
  .modifier-row{ margin-top:8px; display:grid; grid-template-columns:150px 1fr; gap:14px; align-items:start; }
  .modifier-name{ font-size:12px; font-weight:600; color:var(--z700); margin-right:8px; }
  .modifier-rule{ font-size:12px; line-height:1.65; color:var(--z600); }
  .modifier-role{ display:block; color:var(--z400); }
  .signal-flow{ list-style:none; display:flex; flex-direction:column; gap:12px; }
  .signal-flow li{ display:grid; grid-template-columns:76px 1fr; gap:16px; padding:0; align-items:start; }
  .signal-flow li + li{ border-top:0; }
  .flow-label{ font-size:12px; line-height:1.6; font-weight:700; color:var(--z700); }
  .flow-text{ font-size:13px; line-height:1.65; color:var(--z600); }
  .timeline{ list-style:none; display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; }
  .timeline li{ min-width:0; font-size:11px; line-height:1.45; color:var(--z600); }
  .timeline-num{ display:flex; align-items:center; justify-content:center; width:20px; height:20px; border-radius:50%; background:var(--z100); color:var(--z600); font-size:10px; font-weight:700; margin-bottom:6px; }
  .optional-filter-head{ display:flex; align-items:center; gap:8px; margin-bottom:8px; }
  .optional-filter-head .sub{ margin:0; }
  .optional-filter-title{ font-size:13px; font-weight:600; color:var(--z700); }
  .optional-filter-rule{ margin-top:3px; font-size:13px; line-height:1.6; color:var(--z600); }
  .optional-filter-note{ margin-top:4px; font-size:12px; line-height:1.6; color:var(--z400); }
  .para{ font-size:14px; line-height:1.75; color:var(--z600); }
  .sub{ font-size:12px; font-weight:500; color:var(--z500); margin-bottom:10px; }
  .formula{ background:var(--z50); border-radius:8px; padding:12px 16px;
    font-family:var(--mono); font-size:12px; line-height:1.7; color:var(--z700); white-space:pre-wrap; overflow-x:auto; }
  details.derive{ margin-top:10px; }
  details.derive > summary{ list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px;
    font-size:12px; font-weight:500; color:var(--z500); user-select:none; }
  details.derive > summary::-webkit-details-marker{ display:none; }
  details.derive > summary::before{ content:"▸"; color:var(--z400); font-size:11px; transform:translateY(-1px); }
  details.derive[open] > summary::before{ content:"▾"; }
  .derive-body{ margin-top:10px; color:var(--z600); }
  .math-detail-body,.code-evidence-body{ margin-top:12px; }
  .detail-label{ margin:12px 0 6px; font-size:11px; font-weight:600; color:var(--z500); }
  .detail-label:first-child{ margin-top:0; }
  .detail-example{ font-size:12px; line-height:1.7; color:var(--z600); white-space:pre-line; }
  .math-concept-grid{ display:grid; grid-template-columns:1fr; gap:18px; align-items:start; margin-top:12px; }
  .equation-list{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
  .equation-item{ padding:13px 14px; border-radius:9px; background:#fff; }
  .equation-label{ font-size:10px; font-weight:700; letter-spacing:.04em; color:var(--z400); }
  .equation-expression{ margin-top:5px; font-family:"STIX Two Math","Cambria Math","Times New Roman",serif; font-size:17px; line-height:1.55; color:var(--z800); white-space:pre-wrap; overflow-wrap:anywhere; }
  .equation-note{ margin-top:5px; font-size:11px; line-height:1.55; color:var(--z500); }
  .math-variables{ padding-top:2px; }
  .variable-list{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 20px; }
  .detail-example-box{ margin-top:16px; padding:13px 14px; border-radius:9px; background:#fff; }
  .detail-example-box .detail-label{ margin-top:0; }
  .math-example{ font-family:"STIX Two Math","Cambria Math","Times New Roman",var(--font); font-size:13px; font-variant-numeric:lining-nums; }
  .code-evidence-body{ display:grid; grid-template-columns:1fr; gap:12px; }
  .code-evidence-item{ min-width:0; margin:0; border-radius:10px; overflow:hidden; background:#fff; }
  .code-evidence-head{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; background:#fff; }
  .code-evidence-title{ font-size:12px; font-weight:650; color:var(--z700); }
  .code-evidence-lang,.src-hint{ flex:0 0 auto; padding:3px 7px; border-radius:5px; background:var(--z100); font-family:var(--mono); font-size:9px; font-weight:600; letter-spacing:.02em; color:var(--z500); }
  .code-evidence-code,pre.code{ background:var(--z50); font-family:var(--mono); font-size:11.5px; line-height:1.75; color:var(--z700); tab-size:2; }
  .code-evidence-code{ margin:0; padding:14px 16px; white-space:pre; overflow-x:auto; }
  .code-evidence-code code{ font:inherit; color:inherit; }
  .code-evidence-note{ margin:0; padding:10px 12px 11px; font-size:12px; line-height:1.65; color:var(--z500); background:#fff; }
  .usage-edge{ font-size:13px; line-height:1.65; color:var(--z700); }
  .usage-edge > span,.usage-scenes span{ display:block; font-size:11px; font-weight:600; color:var(--z400); margin-bottom:3px; }
  .usage-params{ margin-top:12px; display:grid; grid-template-columns:1fr 1fr; gap:10px 20px; }
  .usage-params strong{ display:block; font-size:12px; color:var(--z600); }
  .usage-params span{ display:block; margin-top:3px; font-size:12px; line-height:1.6; color:var(--z500); }
  .usage-scenes{ margin-top:14px; display:grid; grid-template-columns:1fr 1fr; gap:20px; font-size:12px; line-height:1.65; color:var(--z600); }
  details.deep-detail{ padding:2px 0; }
  details.deep-detail > summary{ min-height:40px; padding:0 2px; color:var(--z600); font-size:12px; font-weight:650; }
  .deep-detail-body{ margin:10px 0 0; padding:16px var(--page-pad); border:0; border-radius:0; background:var(--z50); }
  .variable-list > div{ display:grid; grid-template-columns:62px 1fr; gap:10px; padding:5px 0; }
  .variable-list dt{ font-family:"STIX Two Math","Cambria Math","Times New Roman",serif; font-size:14px; color:var(--z700); }
  .variable-list dd{ font-size:12px; line-height:1.6; color:var(--z500); }
  ul.params{ list-style:none; }
  ul.params li{ padding:10px 0; }
  ul.params li + li{ border-top:1px solid var(--z100); }
  ul.params li:first-child{ padding-top:0; } ul.params li:last-child{ padding-bottom:0; }
  .pname{ display:block; font-weight:600; font-size:14px; color:var(--z700); }
  .peff{ display:block; color:var(--z500); font-size:12px; line-height:1.6; margin-top:2px; }
  ul.params.params-soft .pname{ font-size:13px; font-weight:500; color:var(--z600); }
  ul.params.params-soft .peff{ color:var(--z500); }
  .pname.key{ font-weight:600; color:var(--z700); }
  .kflag{ margin-left:6px; padding:1px 6px; border-radius:9999px; background:var(--posBg); color:var(--posFg); font-size:10px; font-weight:600; }
  .callouts{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .co-lab{ font-size:12px; font-weight:500; color:var(--z500); margin-bottom:6px; }
  .co-txt{ font-size:12px; line-height:1.7; color:var(--z600); } .co-txt.muted{ color:var(--z500); }
  .tags{ display:flex; flex-direction:column; gap:10px; }
  .tagrow{ display:flex; align-items:flex-start; gap:8px; font-size:12px; color:var(--z500); min-width:0; }
  .tk{ width:64px; flex-shrink:0; font-weight:500; color:var(--z600); line-height:1.9; }
  .tnote{ flex:1; min-width:0; color:var(--z400); line-height:1.9; }
  .chip{ display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:9999px; font-size:11px; font-weight:500; border:1px solid transparent; flex-shrink:0; white-space:nowrap; }
  .chip.sm{ font-weight:600; }
  .chip.ok{ background:var(--posBg); color:var(--posFg); border-color:var(--posBd); }
  .chip.warn{ background:var(--warnBg); color:var(--warnFg); border-color:var(--warnBd); }
  .chip.risk{ background:var(--z100); color:var(--z500); border-color:var(--z200); }
  .chip.dstr{ background:var(--negBg); color:var(--negFg); border-color:var(--negBd); }
  /* robustness bar chart */
  .barwrap{ padding-bottom:16px; border-bottom:0; }
  .chart-cap{ font-size:11px; color:var(--z400); margin-bottom:16px; line-height:1.6; }
  .barchart{ display:flex; flex-direction:column; gap:12px; }
  .bar-row{ display:flex; align-items:center; gap:12px; }
  .bar-sym{ font-size:12px; font-weight:700; color:var(--z700); width:56px; flex-shrink:0; }
  .bar-track{ flex:1; position:relative; height:24px; display:flex; }
  .bar-mid{ position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--z200); }
  .bar-side{ position:absolute; top:4px; width:50%; height:16px; display:flex; align-items:center; }
  .bar-side.left{ left:0; justify-content:flex-end; }
  .bar-side.right{ left:50%; justify-content:flex-start; }
  .bar{ height:16px; border-radius:3px; display:block; }
  .bar.pos{ background:var(--pos2); } .bar.neg{ background:var(--neg2); }
  .bar-val{ font-size:12px; font-weight:700; font-variant-numeric:tabular-nums; width:80px; text-align:center; flex-shrink:0; }
  /* table（无卡片，两端齐平） */
  .table-scroll{ width:100%; overflow-x:auto; overscroll-behavior-inline:contain; }
  table.grid{ width:100%; border-collapse:collapse; font-size:12px; }
  table.grid th{ text-align:right; font-size:11px; color:var(--z400); font-weight:500; padding:10px 12px; border-bottom:1px solid var(--z100); }
  table.grid th:first-child{ text-align:left; padding-left:0; } table.grid th:last-child{ padding-right:0; }
  table.grid td{ text-align:right; padding:12px; border-bottom:1px solid var(--z100); font-variant-numeric:tabular-nums; }
  table.grid tr:last-child td{ border-bottom:none; }
  table.grid td:first-child{ text-align:left; padding-left:0; } table.grid td:last-child{ padding-right:0; }
  td.sym{ font-weight:700; color:var(--z700); } td.muted,.muted{ color:var(--z400); } td.big,.big{ font-weight:700; }
  .pos{ color:var(--pos); } .neg{ color:var(--neg); } .neu{ color:var(--z400); }
  .beat{ font-size:12px; color:var(--z500); font-weight:600; background:var(--z100); padding:4px 10px; border-radius:9999px; }
  /* 指标源码折叠 + 复制 */
  .src-heading{ margin-bottom:6px; }
  .src-desc{ font-size:12px; line-height:1.65; color:var(--z400); margin-bottom:12px; }
  details.src > summary{ list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px;
    width:max-content; min-height:36px; font-size:12px; font-weight:600; color:var(--z600); user-select:none; }
  details.src > summary::-webkit-details-marker{ display:none; }
  details.src > summary::before{ content:"▸"; color:var(--z400); font-size:12px; transform:translateY(-1px); }
  details.src[open] > summary::before{ content:"▾"; }
  details.src .src-close{ display:none; }
  details.src[open] .src-open{ display:none; }
  details.src[open] .src-close{ display:inline; }
  .codewrap{ position:relative; margin-top:14px; }
  .copybtn{ position:absolute; top:8px; right:8px; z-index:1; }
  .iconbtn{ display:inline-flex; align-items:center; justify-content:center; width:28px; height:24px; padding:0;
    border-radius:6px; border:1px solid var(--z200); background:var(--bg); color:var(--z500); cursor:pointer; flex-shrink:0; }
  .iconbtn:hover{ background:var(--z50); color:var(--z800); }
  .iconbtn.done{ color:var(--pos); border-color:var(--posBd); background:var(--posBg); }
  pre.code{ border-radius:8px; padding:14px 16px; white-space:pre; overflow-x:auto; max-height:420px; overflow-y:auto; }
  /* 参数敏感性热力图 */
  .hm-toggle{ display:flex; gap:4px; }
  .hm-toggle button{ padding:3px 10px; border-radius:6px; border:1px solid var(--z200); background:var(--bg); color:var(--z500); font-size:11px; font-weight:500; font-family:var(--font); cursor:pointer; }
  .hm-toggle button.on{ background:var(--z900); color:#fff; border-color:var(--z900); }
  .hm-wrap{ position:relative; margin-top:4px; }
  .hm-panel{ width:100%; max-width:100%; }
  .heatmap-svg{ display:block; width:100%; height:auto; }
  .hm-cell{ stroke:rgba(255,255,255,.9); stroke-width:.5; }
  .hm-best{ stroke:var(--z900); stroke-width:2.5; }
  .hm-value{ pointer-events:none; font-size:12px; font-weight:700; font-variant-numeric:tabular-nums; }
  .hm-fixed{ margin-left:6px; color:var(--z400); }
  .hm-tip{ position:absolute; z-index:5; pointer-events:none; background:var(--z900); color:#fff; font-size:11px; line-height:1.5; padding:6px 9px; border-radius:6px; max-width:260px; transform:translate(-50%,-115%); }
  /* P2 深度优化 */
  details.research-detail{ border:1px solid var(--z100); border-radius:12px; background:var(--panel); overflow:hidden; }
  details.research-detail > summary{ min-height:58px; padding:0 18px; display:flex; align-items:center; justify-content:space-between; gap:16px;
    list-style:none; cursor:pointer; color:var(--z800); font-size:15px; font-weight:700; }
  details.research-detail > summary::-webkit-details-marker{ display:none; }
  details.research-detail > summary::after{ content:"展开"; color:var(--z400); font-size:10px; font-weight:600; }
  details.research-detail[open] > summary::after{ content:"收起"; }
  details.research-detail > summary small{ margin-left:auto; color:var(--z400); font-size:11px; font-weight:500; }
  .research-detail-body{ padding:2px 18px 20px; }
  .research-detail-body > section{ padding-top:20px; }
  .research-detail-body > section + section{ margin-top:24px; border-top:1px solid var(--z100); }
  .subsection-title{ color:var(--z700); font-size:13px; font-weight:700; }
  .p2-line{ display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:12px; font-size:12px; }
  .p2-scope{ color:var(--z700); font-weight:650; }
  .p2-objective{ color:var(--z600); font-weight:600; }
  .p2-verdict{ margin:10px 0 14px; font-size:12px; line-height:1.7; color:var(--z500); }
  .p2-param{ max-width:180px; white-space:normal; line-height:1.5; }
  .source-tag{ display:inline-flex; align-items:center; padding:2px 7px; border-radius:4px; background:var(--z100); color:var(--z500); font-size:11px; font-weight:600; line-height:1.5; }
  .market-range{ display:block; margin-top:3px; color:var(--z400); font-size:9px; font-weight:500; line-height:1.4; white-space:nowrap; }
  .oos-cols{ display:grid; grid-template-columns:1fr 1fr; gap:24px; margin:14px 0 4px; }
  .oos-col{ border-top:1px solid var(--z100); padding-top:12px; min-width:0; }
  .oos-main{ font-size:24px; font-weight:700; margin-top:6px; font-variant-numeric:tabular-nums; line-height:1.15; }
  /* footer */
  .foot{ color:var(--z400); font-size:11px; line-height:1.7; }
  .foot b{ color:var(--z500); font-weight:600; }
  .share-status{ position:fixed; left:50%; bottom:20px; z-index:20; min-height:0; max-width:calc(100% - 32px); padding:0;
    border-radius:7px; background:var(--z900); color:#fff; font-size:11px; transform:translateX(-50%); }
  .share-status:not(:empty){ padding:8px 12px; }
  @media (max-width:640px){
    .wrap{ --page-pad:14px; padding:24px var(--page-pad) 36px; }
    hr.rule{ margin:28px 0; }
    .head{ margin-bottom:22px; }
    .report-utility{ align-items:center; }
    .report-action{ min-height:40px; padding-inline:9px; }
    .htitle{ font-size:26px; }
    .stats{ grid-template-columns:repeat(2,minmax(0,1fr)); gap:18px 14px; }
    .stat,.stat:first-child,.stat:last-child{ padding:0; }
    .stat + .stat{ border-left:0; }
    .s-val{ font-size:22px; }
    .costline{ margin-top:16px; }
    .verdict-panel{ margin-top:22px; padding:16px var(--page-pad); }
    .verdict-title{ font-size:16px; }
    .evidence-grid{ grid-template-columns:1fr; gap:12px; }
    .evidence-item,.evidence-item + .evidence-item{ padding:0; border-left:0; }
    .next-action{ grid-template-columns:64px 1fr; }
    .shot-meta{ align-items:flex-start; }
    .spec-grid,.usage-params,.usage-scenes,.callouts,.oos-cols{ grid-template-columns:1fr; }
    .spec-observation{ grid-column:auto; }
    .modifier-row{ grid-template-columns:1fr; gap:4px; }
    .signal-flow li{ grid-template-columns:72px 1fr; gap:12px; }
    .timeline{ grid-template-columns:1fr; gap:12px; }
    .timeline li{ display:grid; grid-template-columns:24px 1fr; gap:8px; align-items:start; }
    .timeline-num{ margin-bottom:0; }
    .sec-h-row{ align-items:flex-start; gap:12px; }
    .bar-row{ gap:8px; }
    .bar-sym{ width:62px; }
    .bar-val{ width:68px; }
    table.grid{ min-width:580px; }
    .optimization-table{ min-width:560px; }
    details.research-detail > summary{ min-height:56px; padding:0 14px; }
    .research-detail-body{ padding:0 14px 16px; }
    .hm-toggle{ flex-shrink:0; }
    .shot-cap{ text-align:left; }
    .equation-list,.variable-list,.code-evidence-body{ grid-template-columns:1fr; }
  }
  @media (max-width:420px){
    .pills{ gap:5px; }
    .pill-t{ max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .hone{ font-size:13px; }
    .content-group,.deep-detail-body{ padding:15px var(--page-pad); }
    .reader-guide-row{ grid-template-columns:1fr; gap:3px; }
    .signal-flow li{ grid-template-columns:1fr; gap:2px; }
    .flow-label{ color:var(--z700); }
    .code-evidence-head{ align-items:flex-start; }
    .code-evidence-code{ padding:13px 12px; }
    .code-evidence-code,pre.code{ font-size:10.5px; }
    details.research-detail > summary small{ display:none; }
  }
</style></head>
<body data-report-template-version="${REPORT_TEMPLATE_VERSION}"><div class="wrap">

  <header class="head">
    <div class="report-utility">
      <div class="pills">
        ${d.type ? `<span class="pill-t">${esc(d.type)}</span>` : ''}
        ${d.symbol ? `<span class="pill-t">${esc(d.symbol)}${d.timeframe ? ' · ' + esc(d.timeframe) : ''}</span>` : ''}
      </div>
      <nav class="report-actions" aria-label="页面操作">
        <a class="report-action" href="../">返回首页</a>
        <button class="report-action" type="button" onclick="shareReport(this)">分享案例</button>
      </nav>
    </div>
    <h1 class="htitle">${esc(d.title || '指标评估')}</h1>
    ${d.oneLiner ? `<p class="hone">${esc(d.oneLiner)}</p>` : ''}
  </header>

  ${body}

  <footer class="foot">
    <b>⚠️ 免责声明：</b>本报告由 CDP 自动化本地 TradingView 生成，<b>非投资建议</b>。回测表现 ≠ 未来收益，
    历史最优参数常含过拟合，切勿据此实盘下单。使用须符合 TradingView 服务条款。
  </footer>

</div>
<div class="share-status" id="share-status" role="status" aria-live="polite"></div>
<script type="application/json" id="case-summary">${caseSummaryJson}</script>
<script>
var CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
function doCopy(btn, sel){
  var host = btn.closest('section'); if(!host) return;
  var el = host.querySelector(sel); if(!el) return;
  navigator.clipboard.writeText(el.textContent.trim()).then(function(){
    var orig = btn.innerHTML; btn.innerHTML = CHECK_SVG; btn.classList.add('done');
    setTimeout(function(){ btn.innerHTML = orig; btn.classList.remove('done'); }, 1500);
  });
}
function toggleShot(btn){
  var wrap = document.getElementById(btn.getAttribute('aria-controls'));
  if (!wrap) return;
  var full = wrap.classList.toggle('is-full');
  btn.setAttribute('aria-expanded', String(full));
  btn.textContent = full ? '收起完整截图' : '查看完整截图';
}
async function shareReport(btn){
  var status = document.getElementById('share-status');
  var original = btn.textContent;
  try {
    if (navigator.share) {
      await navigator.share({ title: document.title, text: '${esc((d.oneLiner || d.title || '指标研究案例').replace(/'/g, "\\'"))}', url: location.href });
      status.textContent = '分享面板已打开。';
    } else {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = '链接已复制';
      status.textContent = '案例链接已复制。';
    }
  } catch (error) {
    if (error && error.name === 'AbortError') return;
    status.textContent = '暂时无法自动分享，请复制浏览器地址。';
  }
  setTimeout(function(){ btn.textContent = original; status.textContent = ''; }, 1600);
}
function hmToggle(btn, m){
  var sec = btn.closest('section');
  sec.querySelectorAll('.hm-toggle button').forEach(function(b){ b.classList.toggle('on', b===btn); });
  sec.querySelectorAll('.heatmap-svg').forEach(function(s){ s.setAttribute('data-metric', m); });
  sec.querySelectorAll('.hm-cell').forEach(function(c){ c.setAttribute('fill', c.getAttribute('data-fill-'+m)); });
  sec.querySelectorAll('.hm-value').forEach(function(t){
    t.textContent = t.getAttribute('data-label-'+m);
    t.setAttribute('fill', t.getAttribute('data-color-'+m));
  });
}
function hmMove(e){
  var cell = e.target.closest ? e.target.closest('.hm-cell') : null;
  var wrap = e.currentTarget, tip = wrap.querySelector('.hm-tip');
  if(!cell || !cell.getAttribute('data-tip')){ tip.hidden = true; return; }
  var r = wrap.getBoundingClientRect();
  tip.textContent = cell.getAttribute('data-tip');
  tip.style.left = (e.clientX - r.left) + 'px';
  tip.style.top = (e.clientY - r.top) + 'px';
  tip.hidden = false;
}
function hmHide(){ document.querySelectorAll('.hm-tip').forEach(function(t){ t.hidden = true; }); }
</script>
</body></html>`;
  return html;
}

function main() {
  const dataPath = process.argv[2];
  if (!dataPath) { console.error('用法: node report.mjs <data.json> [--check|--card]'); process.exit(1); }
  const resolvedDataPath = resolve(dataPath);
  const dataDir = dirname(resolvedDataPath);
  const d = JSON.parse(readFileSync(resolvedDataPath, 'utf8'));
  if (!d.source && d.sourceFile) d.source = readFileSync(resolve(dataDir, d.sourceFile), 'utf8');
  if (!d.screenshot && d.screenshotFile) d.screenshot = resolve(dataDir, d.screenshotFile);
  const out = d.out || join(homedir(), '.tv-skill', 'report.html');
  const { errors, warnings } = validateData(d);
  warnings.forEach(w => console.error('⚠️  ' + w));
  if (errors.length) { errors.forEach(e => console.error('✗ ' + e)); process.exit(1); }
  if (process.argv.includes('--check')) { console.log('✓ data.json 校验通过'); return; }
  if (process.argv.includes('--card')) {
    const cardOut = d.cardOut || join(homedir(), '.tv-skill', 'share_card.html');
    const cardHtml = buildShareCard(d);
    writeFileSync(cardOut, cardHtml);
    if (cardHtml.length < 3000) console.error(`⚠️  生成的分享卡 HTML 体积异常小（${cardHtml.length} 字节），请检查数据`);
    console.log('分享卡 HTML 已生成:', cardOut);
    return;
  }
  const html = buildHtml(d);
  writeFileSync(out, html);
  const size = html.length;
  const missing = [];
  if (d.stats && !html.includes('策略总收益')) missing.push('stats');
  if (d.heatmap && !html.includes('heatmap-svg')) missing.push('heatmap');
  if (size < 2000) console.error(`⚠️  生成的 HTML 体积异常小（${size} 字节），请检查数据`);
  if (missing.length) console.error(`⚠️  这些块有数据但未渲染: ${missing.join(', ')}`);
  console.log('报告已生成:', out);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
