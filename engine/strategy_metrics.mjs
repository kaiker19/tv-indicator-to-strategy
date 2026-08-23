const FLAT_FIELDS = Object.freeze([
  'currency',
  'total_pnl',
  'max_drawdown',
  'profit_factor',
  'total_trades',
  'win_pct',
  'percent_profitable',
  'winning_trades',
  'losing_trades',
  'buy_hold_return',
  'avg_win_loss',
  'sharpe_ratio',
  'sortino_ratio',
  'strategy_return_bench',
  'no_trade',
]);

function present(value) {
  return value !== null && value !== undefined && value !== '';
}

function round6(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function percentagePoints(value) {
  return Number.isFinite(Number(value)) ? `${round6(Number(value) * 100)}%` : null;
}

function put(output, key, value) {
  if (present(value)) output[key] = value;
}

export function normalizeStrategyMetrics(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};

  const output = {};
  for (const key of FLAT_FIELDS) put(output, key, raw[key]);

  const performance = raw.performance && typeof raw.performance === 'object'
    ? raw.performance
    : {};
  const all = performance.all && typeof performance.all === 'object'
    ? performance.all
    : {};

  if (!present(output.currency)) put(output, 'currency', raw.currency);
  if (!present(output.total_pnl)) put(output, 'total_pnl', percentagePoints(all.netProfitPercent));
  if (!present(output.max_drawdown)) put(output, 'max_drawdown', percentagePoints(performance.maxStrategyDrawDownPercent));
  if (!present(output.profit_factor)) put(output, 'profit_factor', all.profitFactor);
  if (!present(output.total_trades)) put(output, 'total_trades', all.totalTrades);
  if (!present(output.win_pct)) put(output, 'win_pct', percentagePoints(all.percentProfitable));
  if (!present(output.percent_profitable)) put(output, 'percent_profitable', output.win_pct);
  if (!present(output.win_pct)) put(output, 'win_pct', output.percent_profitable);
  if (!present(output.winning_trades)) put(output, 'winning_trades', all.numberOfWiningTrades ?? all.numberOfWinningTrades);
  if (!present(output.losing_trades)) put(output, 'losing_trades', all.numberOfLosingTrades);
  if (!present(output.buy_hold_return)) put(output, 'buy_hold_return', percentagePoints(performance.buyHoldReturnPercent));
  if (!present(output.avg_win_loss)) put(output, 'avg_win_loss', all.ratioAvgWinAvgLoss);
  if (!present(output.sharpe_ratio)) put(output, 'sharpe_ratio', performance.sharpeRatio);
  if (!present(output.sortino_ratio)) put(output, 'sortino_ratio', performance.sortinoRatio);

  if (raw.__no_trade === true && !present(output.no_trade)) output.no_trade = true;
  return output;
}

export function hasCoreStrategyMetrics(metrics = {}) {
  if (metrics?.no_trade === true) return present(metrics.total_trades);
  const baseComplete = ['total_pnl', 'max_drawdown', 'total_trades']
    .every(key => present(metrics?.[key]));
  if (!baseComplete) return false;
  if (present(metrics.profit_factor)) return true;

  const totalTrades = Number(metrics.total_trades);
  const winningTrades = Number(metrics.winning_trades);
  const losingTrades = Number(metrics.losing_trades);
  return totalTrades > 0 && losingTrades === 0 && winningTrades === totalTrades;
}
