import { compactEvaluation } from './evaluation_contract.mjs';

function compactOptimization(optimization) {
  if (!optimization) return null;
  const keys = ['mode', 'objective', 'requestedObjective', 'effectiveObjective', 'evaluation', 'budget', 'evaluated', 'axes', 'top', 'shape', 'coarse', 'refinement'];
  return Object.fromEntries(keys.filter(key => optimization[key] !== undefined).map(key => [key, optimization[key]]));
}

function uniqueFiles(files) {
  return [...new Set(files.filter(Boolean))];
}

function nextReadFor(manifest, reportFiles, manifestPath, probePath) {
  const error = manifest.error;
  if (manifest.status === 'failed' && error?.code === 'UNCLASSIFIED_FAILURE') {
    return {
      level: 'full_debug',
      action: 'inspect_debugging',
      files: uniqueFiles([manifestPath, probePath]),
    };
  }
  if (manifest.status === 'failed') {
    return {
      level: 'stage',
      action: error?.retryable ? 'recover_once' : 'request_user_action',
      stage: error?.stage || 'unknown',
      code: error?.code || 'UNKNOWN_FAILURE',
      recommendedAction: error?.recommendedAction || '检查失败阶段后再决定是否重试。',
      files: [],
    };
  }
  if (manifest.status === 'complete' && manifest.mode !== 'selftest' && manifest.proof?.ok !== true) {
    return { level: 'proof', action: 'inspect_proof', files: uniqueFiles([manifestPath]) };
  }
  if (manifest.status === 'complete') {
    return {
      level: 'summary',
      action: manifest.mode === 'selftest' ? 'selftest_complete' : 'generate_report',
      files: uniqueFiles(reportFiles),
    };
  }
  return { level: 'summary', action: 'wait', files: [] };
}

export function buildRunSummary({
  manifest = {},
  pineFile = null,
  sourceTag = null,
  runs = [],
  optimization = null,
  evaluation = null,
  heatmapPath = null,
  manifestPath = null,
  probePath = null,
} = {}) {
  const compact = compactOptimization(optimization);
  const compactEvaluationEvidence = compactEvaluation(evaluation || optimization?.evaluation || manifest.evaluation || {});
  const artifacts = {
    ...(manifest.artifacts || {}),
    ...(heatmapPath ? { heatmap: heatmapPath } : {}),
  };
  const proofBlocked = manifest.status === 'complete'
    && manifest.mode !== 'selftest'
    && manifest.proof?.ok !== true;
  const reportFiles = [
    pineFile,
    artifacts.proofScreenshot,
    artifacts.optimization,
    artifacts.heatmap,
  ];

  return {
    schemaVersion: 2,
    runId: manifest.runId || null,
    status: proofBlocked ? 'blocked' : (manifest.status || 'running'),
    mode: manifest.mode || 'run',
    source: { path: pineFile, tag: sourceTag },
    strategy: {
      scriptName: manifest.intent?.scriptName || null,
      requestedSymbol: manifest.intent?.primarySymbol || null,
      actualSymbol: manifest.proof?.actual?.symbol || null,
      timeframe: manifest.intent?.timeframe || null,
      costs: manifest.intent?.costs || null,
      params: manifest.proof?.actual?.params || null,
    },
    runs,
    evaluation: compactEvaluationEvidence,
    optimization: compact,
    validation: optimization?.validation || null,
    artifacts,
    proof: manifest.proof || null,
    error: manifest.error || null,
    nextRead: nextReadFor(manifest, reportFiles, manifestPath, probePath),
  };
}
