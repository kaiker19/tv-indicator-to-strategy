import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_HORIZONS = [5, 10, 20, 40];
const DEFAULT_BREAK_EVEN_THRESHOLDS = [1, 2, 4];

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function isoDate(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function calculateAtr(bars, length) {
  const values = Array(bars.length).fill(null);
  const trueRanges = bars.map((bar, index) => {
    if (index === 0) return Number(bar.high) - Number(bar.low);
    const previousClose = Number(bars[index - 1].close);
    return Math.max(
      Number(bar.high) - Number(bar.low),
      Math.abs(Number(bar.high) - previousClose),
      Math.abs(Number(bar.low) - previousClose),
    );
  });
  if (trueRanges.length < length) return values;
  let average = trueRanges.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  values[length - 1] = average;
  for (let index = length; index < trueRanges.length; index += 1) {
    average = (average * (length - 1) + trueRanges[index]) / length;
    values[index] = average;
  }
  return values;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return round(sorted[index]);
}

function distribution(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { average: null, median: null, p75: null, max: null };
  return {
    average: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
    median: percentile(finite, 0.5),
    p75: percentile(finite, 0.75),
    max: round(Math.max(...finite)),
  };
}

function dateIndex(bars) {
  return new Map(bars.map((bar, index) => [isoDate(bar.time), index]));
}

function firstOffset(rows, predicate) {
  const index = rows.findIndex(predicate);
  return index < 0 ? null : index + 1;
}

function analyzeBreakEven(attempts, bars, indexes, thresholds, targetWon) {
  const selected = attempts.filter(attempt => Boolean(attempt.won) === targetWon);
  return Object.fromEntries(thresholds.map(threshold => {
    let armed = 0;
    let wouldExit = 0;
    for (const attempt of selected) {
      const entryIndex = indexes.get(attempt.entry_date);
      const exitIndex = indexes.get(attempt.exit_date);
      if (!Number.isInteger(entryIndex) || !Number.isInteger(exitIndex) || exitIndex <= entryIndex) continue;
      const trigger = Number(attempt.entry_price) * (1 + threshold / 100);
      let isArmed = false;
      let exitsAtBreakEven = false;
      for (const bar of bars.slice(entryIndex + 1, exitIndex)) {
        if (Number(bar.high) >= trigger) isArmed = true;
        if (isArmed && Number(bar.close) <= Number(attempt.entry_price)) {
          exitsAtBreakEven = true;
          break;
        }
      }
      if (isArmed) armed += 1;
      if (exitsAtBreakEven) wouldExit += 1;
    }
    return [String(threshold), targetWon ? {
      armed_winners: armed,
      would_cut_winners: wouldExit,
      cut_rate_pct: armed ? round(100 * wouldExit / armed) : 0,
    } : {
      armed_losses: armed,
      would_reduce_losses: wouldExit,
      coverage_pct: selected.length ? round(100 * wouldExit / selected.length) : 0,
    }];
  }));
}

export function buildStopPathAudit(evidence, {
  horizons = DEFAULT_HORIZONS,
  breakEvenThresholds = DEFAULT_BREAK_EVEN_THRESHOLDS,
} = {}) {
  const bars = evidence?.market_data?.bars || [];
  if (!bars.length) throw new TypeError('Evidence must contain market_data.bars.');
  const attempts = (evidence?.audit?.episodes || []).flatMap(episode =>
    (episode.attempts || []).map(attempt => ({ ...attempt, episode_number: episode.episode_number })));
  const indexes = dateIndex(bars);
  const atrLength = Number(evidence?.contract?.parameters?.atr_length || 14);
  const targetPercent = Number(evidence?.contract?.parameters?.fixed_target_pct || 12);
  const atr = calculateAtr(bars, atrLength);
  const maximumHorizon = Math.max(...horizons);
  const stops = [];

  for (const attempt of attempts.filter(item => /Structural stop/i.test(item.exit_reason || ''))) {
    const entryIndex = indexes.get(attempt.entry_date);
    const exitIndex = indexes.get(attempt.exit_date);
    if (!Number.isInteger(entryIndex) || !Number.isInteger(exitIndex)) {
      throw new Error(`STOP_PATH_DATE_MISMATCH: trade ${attempt.trade_number} is missing from OHLC history.`);
    }
    const future = bars.slice(exitIndex + 1, exitIndex + maximumHorizon + 1);
    const barsToReclaimStop = firstOffset(future, bar => Number(bar.close) >= Number(attempt.exit_price));
    const barsToReclaimEntry = firstOffset(future, bar => Number(bar.close) >= Number(attempt.entry_price));
    const nextAttempt = attempts.find(item => item.episode_number === attempt.episode_number
      && item.attempt_index === attempt.attempt_index + 1);
    const nextAttemptEntryIndex = nextAttempt ? indexes.get(nextAttempt.entry_date) : null;
    const barsToNextAttempt = Number.isInteger(nextAttemptEntryIndex) ? nextAttemptEntryIndex - exitIndex : null;
    const targetPrice = Number(attempt.entry_price) * (1 + targetPercent / 100);
    const entryAtr = atr[entryIndex];
    const horizonRows = {};
    for (const horizon of horizons) {
      const window = future.slice(0, horizon);
      if (!window.length) {
        horizonRows[String(horizon)] = null;
        continue;
      }
      const deepest = window.reduce((best, bar) => Number(bar.low) < Number(best.low) ? bar : best);
      const highest = window.reduce((best, bar) => Number(bar.high) > Number(best.high) ? bar : best);
      const decline = Math.max(0, Number(attempt.exit_price) - Number(deepest.low));
      horizonRows[String(horizon)] = {
        observed_bars: window.length,
        further_decline_pct: round(100 * decline / Number(attempt.exit_price)),
        further_decline_atr: Number.isFinite(entryAtr) && entryAtr > 0 ? round(decline / entryAtr) : null,
        max_rebound_pct: round(100 * (Number(highest.high) / Number(attempt.exit_price) - 1)),
        reclaim_stop: window.some(bar => Number(bar.close) >= Number(attempt.exit_price)),
        reclaim_entry: window.some(bar => Number(bar.close) >= Number(attempt.entry_price)),
        deepest_date: isoDate(deepest.time),
      };
    }
    const classification = future.length < maximumHorizon
      ? 'insufficient_future'
      : barsToReclaimStop != null && barsToReclaimStop <= 5
        ? 'fast_reclaim'
        : barsToReclaimStop != null
          ? 'delayed_recovery'
          : 'continued_decline';
    stops.push({
      stop_number: stops.length + 1,
      episode_number: attempt.episode_number,
      attempt_index: attempt.attempt_index,
      entry_date: attempt.entry_date,
      exit_date: attempt.exit_date,
      entry_price: attempt.entry_price,
      exit_price: attempt.exit_price,
      pnl: attempt.pnl,
      pnl_pct: attempt.pnl_pct,
      mfe_pct: attempt.mfe_pct,
      mae_pct: attempt.mae_pct,
      entry_atr: round(entryAtr),
      bars_to_reclaim_stop: barsToReclaimStop,
      bars_to_reclaim_entry: barsToReclaimEntry,
      next_attempt_entry_date: nextAttempt?.entry_date || null,
      bars_to_next_attempt: barsToNextAttempt,
      next_attempt_won: nextAttempt ? Boolean(nextAttempt.won) : null,
      hit_original_target_within_40: future.some(bar => Number(bar.high) >= targetPrice),
      classification,
      horizons: horizonRows,
    });
  }

  const classCounts = Object.fromEntries(['fast_reclaim', 'delayed_recovery', 'continued_decline', 'insufficient_future']
    .map(name => [name, stops.filter(stop => stop.classification === name).length]));
  const horizonSummary = Object.fromEntries(horizons.map(horizon => {
    const rows = stops.map(stop => stop.horizons[String(horizon)]).filter(Boolean);
    const reclaims = rows.filter(row => row.reclaim_stop).length;
    const entryReclaims = rows.filter(row => row.reclaim_entry).length;
    return [String(horizon), {
      observed_stops: rows.length,
      reclaim_stop_rate_pct: rows.length ? round(100 * reclaims / rows.length) : 0,
      reclaim_entry_rate_pct: rows.length ? round(100 * entryReclaims / rows.length) : 0,
      further_decline_pct: distribution(rows.map(row => row.further_decline_pct)),
      further_decline_atr: distribution(rows.map(row => row.further_decline_atr)),
      max_rebound_pct: distribution(rows.map(row => row.max_rebound_pct)),
    }];
  }));
  const stopsWithNextAttempt = stops.filter(stop => Number.isFinite(stop.bars_to_next_attempt));

  return {
    schema_version: 1,
    source_evidence: {
      captured_at: evidence.captured_at || null,
      symbol: evidence?.contract?.symbol || null,
      timeframe: evidence?.contract?.timeframe || null,
      period: evidence?.market_data?.period || null,
      source_sha256: evidence?.contract?.source_sha256 || null,
    },
    summary: {
      structural_stops: stops.length,
      class_counts: classCounts,
      original_entry_reclaimed_within_40: stops.filter(stop => stop.bars_to_reclaim_entry != null && stop.bars_to_reclaim_entry <= 40).length,
      original_target_reached_after_stop: stops.filter(stop => stop.hit_original_target_within_40).length,
      horizon_summary: horizonSummary,
      current_reentry: {
        stops_with_next_attempt: stopsWithNextAttempt.length,
        winning_next_attempts: stopsWithNextAttempt.filter(stop => stop.next_attempt_won).length,
        bars: distribution(stopsWithNextAttempt.map(stop => stop.bars_to_next_attempt)),
      },
    },
    break_even_winner_risk: {
      winning_attempts: attempts.filter(attempt => attempt.won).length,
      thresholds_pct: analyzeBreakEven(attempts, bars, indexes, breakEvenThresholds, true),
    },
    break_even_loss_savings: {
      losing_attempts: attempts.filter(attempt => !attempt.won).length,
      thresholds_pct: analyzeBreakEven(attempts, bars, indexes, breakEvenThresholds, false),
    },
    stops,
  };
}

function cell(value, suffix = '') {
  return value == null ? 'n/a' : `${value}${suffix}`;
}

export function buildStopPathAuditMarkdown(audit) {
  const lines = [
    '# 止损后路径审计',
    '',
    `> 数据：${audit.source_evidence.symbol || 'unknown'} ${audit.source_evidence.timeframe || ''}，${audit.source_evidence.period?.from || '?'} 至 ${audit.source_evidence.period?.to || '?'}；源码摘要 \`${audit.source_evidence.source_sha256 || 'unknown'}\`。`,
    '',
    '## 路径概览',
    '',
    '| 结构止损 | 5根内收复成交价 | 6–40根收复 | 40根未收复 | 40根收复原入场 | 最终达到原12%目标 |',
    '|---:|---:|---:|---:|---:|---:|',
    `| ${audit.summary.structural_stops} | ${audit.summary.class_counts.fast_reclaim} | ${audit.summary.class_counts.delayed_recovery} | ${audit.summary.class_counts.continued_decline} | ${audit.summary.original_entry_reclaimed_within_40} | ${audit.summary.original_target_reached_after_stop} |`,
    '',
    `当前策略在 ${audit.summary.current_reentry.stops_with_next_attempt} 次止损后进行了下一次确认，间隔中位数 ${cell(audit.summary.current_reentry.bars.median)} 根；其中 ${audit.summary.current_reentry.winning_next_attempts} 次下一尝试最终盈利。`,
    '',
    '> “收复成交价”使用 TradingView 的实际退出成交价，不等同于 Pine 冻结的结构止损阈值；它衡量止损后的可交易价格恢复。原入场价收复是更严格的参考。',
    '',
    '## 继续下跌与收复',
    '',
    '| 观察窗 | 成交价收复率 | 原入场收复率 | 继续跌幅中位数 | P75 | 最大 | ATR跌幅中位数 | 最大反弹中位数 |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [horizon, row] of Object.entries(audit.summary.horizon_summary)) {
    lines.push(`| ${horizon} 根 | ${cell(row.reclaim_stop_rate_pct, '%')} | ${cell(row.reclaim_entry_rate_pct, '%')} | ${cell(row.further_decline_pct.median, '%')} | ${cell(row.further_decline_pct.p75, '%')} | ${cell(row.further_decline_pct.max, '%')} | ${cell(row.further_decline_atr.median, ' ATR')} | ${cell(row.max_rebound_pct.median, '%')} |`);
  }
  lines.push(
    '',
    '## 保本误杀风险',
    '',
    '阈值只按“达到浮盈后，目标前某次收盘回到入场价”模拟简单保本。它不是推荐规则，只用于判断简单保本是否会误杀最终达到 12% 的成功尝试。',
    '',
    '| 浮盈阈值 | 触发的成功尝试 | 会被提前切掉 | 误杀率 | 覆盖的亏损尝试 |',
    '|---:|---:|---:|---:|---:|',
  );
  for (const [threshold, winner] of Object.entries(audit.break_even_winner_risk.thresholds_pct)) {
    const loss = audit.break_even_loss_savings.thresholds_pct[threshold];
    lines.push(`| ${threshold}% | ${winner.armed_winners} | ${winner.would_cut_winners} | ${winner.cut_rate_pct}% | ${loss.would_reduce_losses}/${audit.break_even_loss_savings.losing_attempts} |`);
  }
  lines.push(
    '',
    '## 逐次结构止损',
    '',
    '| # | Episode/尝试 | 入场 → 止损 | 已实现损失 | 止损前MFE | 收复成交/入场 | 下次确认 | 40根继续跌幅 | 40根达到原目标 | 分类 |',
    '|---:|---:|---|---:|---:|---:|---:|---:|---:|---|',
  );
  for (const stop of audit.stops) {
    const row = stop.horizons['40'];
    lines.push(`| ${stop.stop_number} | ${stop.episode_number}/${stop.attempt_index} | ${stop.entry_date} → ${stop.exit_date} | ${cell(stop.pnl_pct, '%')} | ${cell(stop.mfe_pct, '%')} | ${cell(stop.bars_to_reclaim_stop)}/${cell(stop.bars_to_reclaim_entry)} 根 | ${cell(stop.bars_to_next_attempt)} 根${stop.next_attempt_won == null ? '' : stop.next_attempt_won ? '（赢）' : '（亏）'} | ${cell(row?.further_decline_pct, '%')} | ${stop.hit_original_target_within_40 ? '是' : '否'} | ${stop.classification} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

async function runCli(argv) {
  const evidencePath = valueAfter(argv, '--evidence');
  const out = valueAfter(argv, '--out');
  const markdown = valueAfter(argv, '--markdown');
  if (!evidencePath || !out) {
    throw new Error('Usage: node stop_path_audit.mjs --evidence <evidence.json> --out <audit.json> [--markdown <audit.md>]');
  }
  const evidence = JSON.parse(await readFile(path.resolve(evidencePath), 'utf8'));
  const audit = buildStopPathAudit(evidence);
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(path.resolve(out), `${JSON.stringify(audit, null, 2)}\n`);
  if (markdown) {
    await mkdir(path.dirname(path.resolve(markdown)), { recursive: true });
    await writeFile(path.resolve(markdown), `${buildStopPathAuditMarkdown(audit)}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    out: path.resolve(out),
    markdown: markdown ? path.resolve(markdown) : null,
    summary: audit.summary,
    break_even_winner_risk: audit.break_even_winner_risk,
  }, null, 2)}\n`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
