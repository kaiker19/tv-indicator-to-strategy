export function normalizeNoTradeMetrics(metrics = {}, noTrade = false) {
  if (!noTrade) return metrics;

  return {
    ...metrics,
    total_trades: metrics.total_trades ?? '0',
    winning_trades: metrics.winning_trades ?? '0/0',
    no_trade: true,
  };
}

export function assertRuntimeMetricsCredible(metrics, hasRuntimeOverrides) {
  if (hasRuntimeOverrides && metrics?.no_trade) {
    throw new Error('INPUT_UPDATE_REQUIRES_REINJECT: runtime input override returned an unverified no-trade report');
  }
  return metrics;
}
