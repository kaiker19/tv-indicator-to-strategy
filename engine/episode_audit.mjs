import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { wilsonLowerBound } from './scan_summary.mjs';

const FIRST_ENTRY = 'First rebound';
const REENTRY = 'Rebound re-entry';
const PROBE_CONFIRMATION_ADD = 'Probe confirmation add';
const MFE_THRESHOLDS = [1, 2, 4, 6, 8];

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percent(value) {
  return round(numeric(value) * 100);
}

function isoDate(timestamp) {
  const date = new Date(numeric(timestamp));
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function normalizeTrade(raw, index) {
  const entry = raw?.e || {};
  const exit = raw?.x || {};
  const pnl = numeric(raw?.tp?.v);
  return {
    trade_number: index + 1,
    entry_key: `${numeric(entry.tm)}|${round(numeric(entry.p))}|${String(entry.c || '')}`,
    exit_key: `${numeric(exit.tm)}|${String(exit.c || '')}`,
    entry_comment: String(entry.c || ''),
    exit_reason: String(exit.c || ''),
    entry_date: isoDate(entry.tm),
    exit_date: isoDate(exit.tm),
    entry_price: round(numeric(entry.p)),
    exit_price: round(numeric(exit.p)),
    quantity: round(numeric(raw?.q)),
    bars_held: Number.isFinite(Number(entry.b)) && Number.isFinite(Number(exit.b))
      ? Math.max(0, Number(exit.b) - Number(entry.b))
      : null,
    pnl: round(pnl),
    pnl_pct: percent(raw?.tp?.p),
    mfe_pct: percent(raw?.rn?.p),
    mae_pct: percent(raw?.dd?.p),
    commission: round(numeric(typeof raw?.cm === 'object' ? raw.cm?.v : raw?.cm)),
    won: pnl > 0,
    fill_count: 1,
  };
}

function collapsePartialFills(rawTrades) {
  const fills = rawTrades.map(normalizeTrade);
  const attempts = [];
  for (const fill of fills) {
    const previous = attempts.at(-1);
    if (!previous || previous.entry_key !== fill.entry_key) {
      attempts.push(fill);
      continue;
    }

    const previousQuantity = numeric(previous.quantity);
    const fillQuantity = numeric(fill.quantity);
    const totalQuantity = previousQuantity + fillQuantity;
    const weighted = (left, right) => totalQuantity > 0
      ? round((numeric(left) * previousQuantity + numeric(right) * fillQuantity) / totalQuantity)
      : 0;
    previous.exit_reason = `${previous.exit_reason} + ${fill.exit_reason}`;
    previous.exit_date = fill.exit_date;
    previous.exit_price = weighted(previous.exit_price, fill.exit_price);
    previous.quantity = round(totalQuantity);
    previous.bars_held = Math.max(numeric(previous.bars_held), numeric(fill.bars_held));
    previous.pnl = round(numeric(previous.pnl) + numeric(fill.pnl));
    previous.pnl_pct = weighted(previous.pnl_pct, fill.pnl_pct);
    previous.mfe_pct = round(Math.max(numeric(previous.mfe_pct), numeric(fill.mfe_pct)));
    previous.mae_pct = round(Math.max(numeric(previous.mae_pct), numeric(fill.mae_pct)));
    previous.commission = round(numeric(previous.commission) + numeric(fill.commission));
    previous.won = previous.pnl > 0;
    previous.fill_count += 1;
  }
  return attempts;
}

function collapseProbeConfirmationAdds(attempts) {
  const merged = [];
  for (const attempt of attempts) {
    if (attempt.entry_comment !== PROBE_CONFIRMATION_ADD) {
      merged.push(attempt);
      continue;
    }

    const previous = merged.at(-1);
    if (!previous || previous.entry_comment !== FIRST_ENTRY || previous.exit_key !== attempt.exit_key) {
      throw new Error('Probe confirmation add has no matching First rebound attempt with the same exit identity.');
    }
    const previousQuantity = numeric(previous.quantity);
    const addQuantity = numeric(attempt.quantity);
    const totalQuantity = previousQuantity + addQuantity;
    const weighted = (left, right) => totalQuantity > 0
      ? round((numeric(left) * previousQuantity + numeric(right) * addQuantity) / totalQuantity)
      : 0;
    previous.entry_price = weighted(previous.entry_price, attempt.entry_price);
    previous.exit_price = weighted(previous.exit_price, attempt.exit_price);
    previous.quantity = round(totalQuantity);
    previous.bars_held = Math.max(numeric(previous.bars_held), numeric(attempt.bars_held));
    previous.pnl = round(numeric(previous.pnl) + numeric(attempt.pnl));
    previous.pnl_pct = weighted(previous.pnl_pct, attempt.pnl_pct);
    previous.mfe_pct = round(Math.max(numeric(previous.mfe_pct), numeric(attempt.mfe_pct)));
    previous.mae_pct = round(Math.max(numeric(previous.mae_pct), numeric(attempt.mae_pct)));
    previous.commission = round(numeric(previous.commission) + numeric(attempt.commission));
    previous.won = previous.pnl > 0;
    previous.fill_count += attempt.fill_count;
  }
  return merged.map((attempt, index) => {
    const { entry_key, exit_key, ...publicAttempt } = attempt;
    return { ...publicAttempt, trade_number: index + 1 };
  });
}

function classifyEpisode(episode) {
  if (!episode.successful) return 'persistent_decline';
  return episode.attempt_count === 1 ? 'single_bottom' : 'multi_bottom';
}

export function buildEpisodeAudit(rawTrades, { strategyName = null } = {}) {
  if (!Array.isArray(rawTrades)) throw new TypeError('TradingView trades must be an array.');

  const openFills = rawTrades.filter(raw => !String(raw?.x?.c || '').trim());
  const closedFills = rawTrades.filter(raw => String(raw?.x?.c || '').trim());
  const observedTradeAttempts = collapseProbeConfirmationAdds(collapsePartialFills(closedFills));
  const openAttempts = collapseProbeConfirmationAdds(collapsePartialFills(openFills));
  const episodes = [];
  let current = null;
  for (let index = 0; index < observedTradeAttempts.length; index += 1) {
    const attempt = observedTradeAttempts[index];
    if (attempt.entry_comment === FIRST_ENTRY) {
      current = { episode_number: episodes.length + 1, attempts: [] };
      episodes.push(current);
    } else if (!current) {
      throw new Error(`Trade ${index + 1} is a re-entry without a preceding First rebound.`);
    } else if (attempt.entry_comment !== REENTRY) {
      throw new Error(`Trade ${index + 1} has an unrecognized entry comment: ${attempt.entry_comment || '(empty)'}.`);
    }
    current.attempts.push({ ...attempt, attempt_index: current.attempts.length + 1 });
  }

  const openEpisodes = [];
  if (openAttempts.length) {
    const firstOpen = openAttempts[0];
    let openEpisode;
    if (firstOpen.entry_comment === REENTRY) {
      openEpisode = episodes.pop();
      if (!openEpisode) throw new Error('Open re-entry has no preceding First rebound episode.');
    } else if (firstOpen.entry_comment === FIRST_ENTRY) {
      openEpisode = { episode_number: episodes.length + 1, attempts: [] };
    } else {
      throw new Error(`Open trade has an unrecognized entry comment: ${firstOpen.entry_comment || '(empty)'}.`);
    }
    openEpisodes.push({
      episode_number: openEpisode.episode_number,
      start_date: openEpisode.attempts[0]?.entry_date || firstOpen.entry_date,
      closed_attempts: openEpisode.attempts,
      open_attempts: openAttempts.map((attempt, index) => ({
        ...attempt,
        attempt_index: openEpisode.attempts.length + index + 1,
      })),
    });
  }

  for (const episode of episodes) {
    episode.attempt_count = episode.attempts.length;
    episode.start_date = episode.attempts[0]?.entry_date || null;
    episode.end_date = episode.attempts.at(-1)?.exit_date || null;
    episode.realized_pnl = round(episode.attempts.reduce((sum, item) => sum + numeric(item.pnl), 0));
    episode.successful = episode.realized_pnl > 0;
    episode.structural_stops = episode.attempts.filter(item => /Structural stop/i.test(item.exit_reason)).length;
    episode.max_mfe_pct = round(Math.max(...episode.attempts.map(item => numeric(item.mfe_pct))));
    episode.worst_mae_pct = round(Math.max(...episode.attempts.map(item => numeric(item.mae_pct))));
    episode.exit_path = episode.attempts.map(item => item.exit_reason);
    episode.classification = classifyEpisode(episode);
    episode.terminal_reason = episode.successful && /Target/i.test(episode.attempts.at(-1)?.exit_reason || '')
      ? 'target'
      : 'not_observable_from_trade_report';
  }

  const tradeCount = episodes.reduce((sum, episode) => sum + episode.attempts.length, 0);
  const successfulEpisodes = episodes.filter(item => item.successful).length;
  const winningTrades = episodes.flatMap(item => item.attempts).filter(item => item.won).length;
  const structuralStops = episodes.reduce((sum, item) => sum + item.structural_stops, 0);
  const pathCounts = {
    single_bottom: episodes.filter(item => item.classification === 'single_bottom').length,
    multi_bottom: episodes.filter(item => item.classification === 'multi_bottom').length,
    persistent_decline: episodes.filter(item => item.classification === 'persistent_decline').length,
  };
  const losingAttempts = episodes.flatMap(item => item.attempts).filter(item => item.pnl < 0);
  const thresholds = Object.fromEntries(MFE_THRESHOLDS.map(threshold => {
    const reached = losingAttempts.filter(item => item.mfe_pct >= threshold).length;
    return [String(threshold), {
      reached,
      total: losingAttempts.length,
      rate_pct: losingAttempts.length ? round(100 * reached / losingAttempts.length) : 0,
    }];
  }));

  return {
    schema_version: 1,
    source: 'TradingView reportData.trades',
    strategy_name: strategyName,
    summary: {
      episode_count: episodes.length,
      open_episode_count: openEpisodes.length,
      successful_episodes: successfulEpisodes,
      episode_success_rate_pct: episodes.length ? round(100 * successfulEpisodes / episodes.length) : 0,
      wilson_lower_bound_pct: episodes.length ? round(100 * wilsonLowerBound(successfulEpisodes, episodes.length)) : null,
      observed_fill_count: rawTrades.length,
      closed_fill_count: closedFills.length,
      open_fill_count: openFills.length,
      observed_trade_count: observedTradeAttempts.length,
      trade_count: tradeCount,
      winning_trades: winningTrades,
      trade_win_rate_pct: tradeCount ? round(100 * winningTrades / tradeCount) : 0,
      average_attempts: episodes.length ? round(tradeCount / episodes.length) : 0,
      structural_stops: structuralStops,
      worst_episode_pnl: episodes.length ? round(Math.min(...episodes.map(item => item.realized_pnl))) : null,
      path_counts: pathCounts,
    },
    losing_attempt_mfe: {
      losing_attempts: losingAttempts.length,
      thresholds_pct: thresholds,
    },
    episodes,
    open_episodes: openEpisodes,
  };
}

function money(value) {
  return Number(value).toFixed(2);
}

export function buildEpisodeAuditMarkdown(audit) {
  const summary = audit.summary;
  const pathCounts = summary.path_counts;
  const lines = [
    '# RSI + UO Episode 路径审计',
    '',
    `> 数据源：TradingView \`reportData.trades\`；策略：\`${audit.strategy_name || 'unknown'}\`。每个 \`First rebound\` 开启一轮 Episode，后续 \`Rebound re-entry\` 归入同一轮。`,
    '',
    '## 审计结论',
    '',
    '| 已完成 Episode | 未完成 Episode | 成功 | Wilson 下界 | 尝试 | 平仓记录 | 尝试胜率 | 平均尝试 | 结构止损 | 最差 Episode |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| ${summary.episode_count} | ${summary.open_episode_count} | ${summary.successful_episodes} (${summary.episode_success_rate_pct}%) | ${summary.wilson_lower_bound_pct}% | ${summary.trade_count} | ${summary.closed_fill_count} | ${summary.winning_trades} (${summary.trade_win_rate_pct}%) | ${summary.average_attempts} | ${summary.structural_stops} | ${money(summary.worst_episode_pnl)} |`,
    '',
    `路径分布：\`single_bottom\` ${pathCounts.single_bottom} 轮，\`multi_bottom\` ${pathCounts.multi_bottom} 轮，\`persistent_decline\` ${pathCounts.persistent_decline} 轮。`,
    '',
    '## 保本止损证据',
    '',
    '下表只看最终亏损的单次尝试，统计其在止损前达到过的最大有利波动（MFE）。如果很少触及某个阈值，在该阈值启用保本止损就无法普遍降低试错成本。',
    '',
    '| MFE 阈值 | 达到次数 | 占亏损尝试 |',
    '|---:|---:|---:|',
  ];
  for (const [threshold, evidence] of Object.entries(audit.losing_attempt_mfe.thresholds_pct)) {
    lines.push(`| ${threshold}% | ${evidence.reached}/${evidence.total} | ${evidence.rate_pct}% |`);
  }
  const onePct = audit.losing_attempt_mfe.thresholds_pct['1'];
  const sixPct = audit.losing_attempt_mfe.thresholds_pct['6'];
  const eightPct = audit.losing_attempt_mfe.thresholds_pct['8'];
  lines.push(
    '',
    `审计判断：\`6%\` 与 \`8%\` 阈值分别只能覆盖 ${sixPct?.reached || 0}/${sixPct?.total || 0} 和 ${eightPct?.reached || 0}/${eightPct?.total || 0} 次亏损尝试，无法解释或挽救主要试错成本。\`1%\` 虽覆盖 ${onePct?.reached || 0}/${onePct?.total || 0} 次，但对日线 ETF 过于接近正常波动；因此不采用“触价即保本”，若后续测试保本，只允许使用 \`1R + 已确认更高低点 + 成本缓冲\` 的证据门控版本。`,
    '',
    '## Episode 明细',
    '',
    '| # | 起止日期 | 尝试 | 退出路径 | Episode PnL | 最大 MFE | 最差 MAE | 分类 |',
    '|---:|---|---:|---|---:|---:|---:|---|',
  );
  for (const episode of audit.episodes) {
    lines.push(`| ${episode.episode_number} | ${episode.start_date} 至 ${episode.end_date} | ${episode.attempt_count} | ${episode.exit_path.join(' → ')} | ${money(episode.realized_pnl)} | ${episode.max_mfe_pct}% | ${episode.worst_mae_pct}% | ${episode.classification} |`);
  }
  lines.push(
    '',
    '## 边界',
    '',
    'TradingView 的逐笔报告能证明每次尝试的价格路径和整轮损益，但失败 Episode 的最终终止原因没有随交易记录暴露。因此报告标为 `not_observable_from_trade_report`，后续仅在研究 crisis re-arm 时补充最小状态诊断，不据此猜测。',
    '',
  );
  return lines.join('\n');
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

async function runCli(argv) {
  const strategyName = valueAfter(argv, '--strategy');
  const out = valueAfter(argv, '--out');
  const markdownOut = valueAfter(argv, '--markdown');
  if (!strategyName || !out) {
    throw new Error('Usage: node episode_audit.mjs --strategy <name> --out <audit.json> [--markdown <audit.md>]');
  }
  const [{ getTrades }, { disconnect }] = await Promise.all([
    import('./core/data.js'),
    import('./connection.js'),
  ]);
  try {
    const evidence = await getTrades({ strategy_name: strategyName, max_trades: 500 });
    if (!evidence.success || evidence.dataset !== 'reportData.trades') {
      throw new Error(evidence.error || `Rich TradingView trade report unavailable (dataset: ${evidence.dataset || 'none'}).`);
    }
    const audit = buildEpisodeAudit(evidence.trades, { strategyName: evidence.strategy_name || strategyName });
    await mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await writeFile(out, `${JSON.stringify(audit, null, 2)}\n`);
    if (markdownOut) {
      await mkdir(path.dirname(path.resolve(markdownOut)), { recursive: true });
      await writeFile(markdownOut, `${buildEpisodeAuditMarkdown(audit)}\n`);
    }
    process.stdout.write(`${JSON.stringify({ out, markdown: markdownOut, summary: audit.summary }, null, 2)}\n`);
  } finally {
    await disconnect();
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
