const round2 = (n) => Math.round(Number(n) * 100) / 100;

function ratioValue(ratio) {
  const n = Number(ratio);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`bad split ratio: ${ratio}`);
  return n > 1 ? n / 100 : n;
}
export function splitByRatio(items, ratio = 0.7) {
  const r = ratioValue(ratio);
  const cut = Math.max(1, Math.min(items.length - 1, Math.round(items.length * r)));
  const train = items.slice(0, cut);
  const test = items.slice(cut);
  return { train, test, trainCount: train.length, testCount: test.length, ratio: r };
}

function decayOne(trainValue, testValue) {
  const a = Number(trainValue);
  const b = Number(testValue);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return round2((b - a) / Math.abs(a) * 100);
}

export function calculateDecay(train = {}, test = {}) {
  return {
    retPct: decayOne(train.ret, test.ret),
    alphaPct: decayOne(train.alpha, test.alpha),
  };
}

function decayVerdict({ status, train, test, decay }) {
  if (status === 'unavailable') return 'TV 时间范围证明未验证，不声称真实样本外。';
  if (!train || !test || !decay) return '样本外数据不足，暂不能判断。';
  if (test.trades != null && test.trades < 10) return '测试段交易数偏少，样本不足。';
  if ((decay.ret_pct != null && decay.ret_pct <= -70) || (decay.alpha_pct != null && decay.alpha_pct <= -100)) {
    return '测试段明显衰减，疑似过拟合。';
  }
  if (train.alpha > 0 && test.alpha < 0) return '训练段跑赢但测试段转负，疑似过拟合。';
  return '训练段到测试段未出现严重衰减。';
}

export function buildOosSummary({
  method = 'split 70/30',
  status = 'unavailable',
  train = null,
  test = null,
} = {}) {
  if (status === 'unavailable' || !train || !test) {
    return {
      method,
      status,
      train,
      test,
      decay: null,
      verdict: decayVerdict({ status, train, test, decay: null }),
    };
  }
  const d = calculateDecay(train, test);
  const decay = {
    ret_pct: d.retPct,
    alpha_pct: d.alphaPct,
    verdict: decayVerdict({ status, train, test, decay: { ret_pct: d.retPct, alpha_pct: d.alphaPct } }),
  };
  return { method, status, train, test, decay, verdict: decay.verdict };
}

export function aggregateWalkForward(windows = []) {
  const decays = windows.map(w => calculateDecay(w.train, w.test));
  const vals = (key) => decays.map(d => d[key]).filter(v => v != null && Number.isFinite(v));
  const avg = (arr) => arr.length ? round2(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const pass = windows.filter(w => Number(w.test?.alpha) > 0).length;
  return {
    windows: windows.length,
    pass,
    passRate: `${pass} / ${windows.length}`,
    avgDecay: {
      ret_pct: avg(vals('retPct')),
      alpha_pct: avg(vals('alphaPct')),
    },
  };
}
