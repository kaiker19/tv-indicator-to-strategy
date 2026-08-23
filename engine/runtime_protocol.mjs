const FAILURE_RULES = [
  {
    pattern: /CDP not reachable|ECONNREFUSED.*9222|fetch failed/i,
    code: 'CDP_UNREACHABLE', severity: 'user_action', retryable: false,
    recommendedAction: '运行 tv_probe；若 TradingView 正常但仍失败，在沙箱外验证 9222，必要时按 SETUP.md 重新启动。',
  },
  {
    pattern: /No TradingView chart target|No TradingView chart tab/i,
    code: 'TV_CHART_TARGET_MISSING', severity: 'user_action', retryable: false,
    recommendedAction: '在 TradingView Desktop 打开一个 chart 页面，再运行 tv_probe；不要在非图表 target 上继续。',
  },
  {
    pattern: /CHART_LAYOUT_NOT_FOUND|CHART_LAYOUT_NOT_READY|CHART_LAYOUT_UNSAVED_CHANGES/i,
    code: 'CHART_LAYOUT_UNAVAILABLE', severity: 'user_action', retryable: false,
    recommendedAction: '确认本机已保存同名的干净截图布局；若存在未保存修改，先由用户决定保存或放弃，再重试。不要自动舍弃修改或模糊匹配其他布局。',
  },
  {
    pattern: /Could not open Pine Editor|Monaco.*not|pine.*unavailable/i,
    code: 'PINE_EDITOR_UNAVAILABLE', severity: 'retryable', retryable: true,
    recommendedAction: '运行 tv_probe 检查 pineDialog 与 Monaco；关闭遮挡弹窗后只重开 Pine 面板一次。',
  },
  {
    pattern: /strategy_not_applied|not_applied|图表上无此策略/i,
    code: 'STRATEGY_NOT_APPLIED', severity: 'retryable', retryable: true,
    recommendedAction: '确认图上存在目标 strategy study；重新执行添加到图表一次，仍失败则停止并保存 probe。',
  },
  {
    pattern: /strategy_select_failed|未能定位到目标策略|未能选中目标策略/i,
    code: 'STRATEGY_SELECTION_MISMATCH', severity: 'retryable', retryable: true,
    recommendedAction: '打开 Strategy Tester 并选择目标策略；回验当前策略名，不得读取旧策略 metrics。',
  },
  {
    pattern: /INPUT_UPDATE_MISMATCH/i,
    code: 'INPUT_UPDATE_MISMATCH', severity: 'retryable', retryable: true,
    recommendedAction: '停止本轮扫描；刷新目标 strategy study 后只重试当前参数一次，仍不一致则改为重新注入。',
  },
  {
    pattern: /INPUT_UPDATE_REQUIRES_REINJECT/i,
    code: 'INPUT_UPDATE_REQUIRES_REINJECT', severity: 'retryable', retryable: true,
    recommendedAction: '停止本轮扫描；把参数写入源码后重新注入并逐组回测，不得复用当前 study 生成网格。',
  },
  {
    pattern: /SOURCE_INPUT_MISMATCH/i,
    code: 'SOURCE_INPUT_MISMATCH', severity: 'fatal', retryable: false,
    recommendedAction: '停止回测并核对源码默认参数、参数标题和当前目标策略；修正后重新注入，不得记录未回验的邻域证据。',
  },
  {
    pattern: /REPORT_RECALC_TIMEOUT/i,
    code: 'REPORT_RECALC_TIMEOUT', severity: 'retryable', retryable: true,
    recommendedAction: '停止读取占位数据；等待 Strategy Tester 更新完成后只重试当前标的或参数一次。',
  },
  {
    pattern: /STRATEGY_METRICS_INCOMPLETE/i,
    code: 'STRATEGY_METRICS_INCOMPLETE', severity: 'fatal', retryable: false,
    recommendedAction: '保存当前 Strategy Tester 探针并检查嵌套报告映射；核心 KPI 补齐前禁止生成报告或策略档案。',
  },
  {
    pattern: /cannot restore P2 proof state|proof context|proof state/i,
    code: 'PROOF_STATE_MISMATCH', severity: 'fatal', retryable: false,
    recommendedAction: '不要截图或生成报告；切回主标的、Top-1 参数与目标策略，重新通过一致性检查。',
  },
];

export function classifyFailure(error) {
  const message = String(error?.message || error || 'unknown failure');
  const matched = FAILURE_RULES.find(rule => rule.pattern.test(message));
  if (matched) {
    const { pattern: _pattern, ...result } = matched;
    return result;
  }
  return {
    code: 'UNCLASSIFIED_FAILURE',
    severity: 'fatal',
    retryable: false,
    recommendedAction: '停止盲目重试，保存 tv_probe 与 run_manifest.json，并按 public-debugging.md 用原始错误定位。',
  };
}

export function buildRunManifest({ mode, scriptName, primarySymbol, timeframe, costs, outputDir } = {}) {
  return {
    schemaVersion: 1,
    runId: `tv-${Date.now()}`,
    startedAt: new Date().toISOString(),
    status: 'running',
    mode: mode || 'run',
    intent: {
      scriptName: scriptName || null,
      primarySymbol: primarySymbol || null,
      timeframe: timeframe || null,
      costs: costs || null,
    },
    stages: {},
    proof: null,
    artifacts: outputDir ? { outputDir } : {},
    error: null,
  };
}

export function completeStage(manifest, name, { evidence = null, artifacts = null } = {}) {
  manifest.stages[name] = {
    status: 'complete',
    completedAt: new Date().toISOString(),
    ...(evidence ? { evidence } : {}),
  };
  if (artifacts) Object.assign(manifest.artifacts, artifacts);
  return manifest;
}

export function failManifest(manifest, error, stage = 'unknown') {
  const classified = classifyFailure(error);
  manifest.status = 'failed';
  manifest.finishedAt = new Date().toISOString();
  manifest.error = { stage, message: String(error?.message || error), ...classified };
  manifest.stages[stage] = { status: 'failed', failedAt: manifest.finishedAt, error: manifest.error };
  return manifest;
}

export function finishManifest(manifest) {
  manifest.status = 'complete';
  manifest.finishedAt = new Date().toISOString();
  return manifest;
}

function symbolTicker(symbol) {
  return String(symbol || '').trim().toUpperCase().split(':').pop();
}

function symbolsEquivalent(expected, actual) {
  if (!expected || !actual) return expected === actual;
  return String(expected).toUpperCase() === String(actual).toUpperCase()
    || symbolTicker(expected) === symbolTicker(actual);
}

export function verifyProofContext({ expected = {}, actual = {} } = {}) {
  const mismatches = [];
  if (expected.symbol && !symbolsEquivalent(expected.symbol, actual.symbol)) {
    mismatches.push({ field: 'symbol', expected: expected.symbol, actual: actual.symbol || null });
  }
  if (expected.strategyName && actual.strategyName !== expected.strategyName) {
    mismatches.push({ field: 'strategyName', expected: expected.strategyName, actual: actual.strategyName || null });
  }
  for (const [name, value] of Object.entries(expected.params || {})) {
    if (actual.params?.[name] !== value) {
      mismatches.push({ field: `params.${name}`, expected: value, actual: actual.params?.[name] ?? null });
    }
  }
  return { ok: mismatches.length === 0, mismatches, expected, actual };
}
