import { CASE_FAMILIES } from './case_library.mjs';

const COMPLEMENTS = Object.freeze({
  trend: Object.freeze([
    Object.freeze({
      component: 'momentum_confirmation',
      why: '确认趋势正在延续，减少仅因慢速均线滞后而入场。',
      risk: '确认条件过严会错过趋势早段。',
    }),
    Object.freeze({
      component: 'volatility_range_filter',
      why: '避开波动收缩或无方向震荡阶段。',
      risk: '波动阈值可能随市场状态失效。',
    }),
    Object.freeze({
      component: 'state_aware_exit',
      why: '用趋势失效或跟踪条件管理离场，而不只依赖反向交叉。',
      risk: '更快离场可能增加反复交易。',
    }),
  ]),
  mean_reversion: Object.freeze([
    Object.freeze({
      component: 'trend_veto',
      why: '强单边趋势中暂停逆势入场，控制尾部亏损。',
      risk: '过滤器可能挡住快速反转机会。',
    }),
    Object.freeze({
      component: 'volatility_normalization',
      why: '按当期波动调整偏离阈值，使信号尺度更可比。',
      risk: '极端波动会让阈值变化过快。',
    }),
    Object.freeze({
      component: 'mean_or_time_exit',
      why: '价格回归目标或等待超时即退出，限制资金占用。',
      risk: '时间退出可能在修复前锁定亏损。',
    }),
  ]),
  breakout: Object.freeze([
    Object.freeze({
      component: 'participation_confirmation',
      why: '用成交活跃度或波动扩张确认突破具有参与度。',
      risk: '确认数据也可能在假突破时放大。',
    }),
    Object.freeze({
      component: 'prior_channel',
      why: '只使用前序区间定义边界，避免把当前 K 线写入自身门槛。',
      risk: '较长通道会降低信号频率。',
    }),
    Object.freeze({
      component: 'trailing_state_exit',
      why: '让盈利趋势继续运行，并在突破状态破坏后退出。',
      risk: '跟踪退出会回吐部分浮盈。',
    }),
  ]),
  state_switching: Object.freeze([
    Object.freeze({
      component: 'regime_boundary',
      why: '用可审阅的边界明确何时切换策略状态。',
      risk: '边界附近可能频繁切换。',
    }),
    Object.freeze({
      component: 'per_state_signal',
      why: '为不同状态定义各自的入场依据，避免一套规则覆盖所有环境。',
      risk: '状态和规则增多会提高过拟合风险。',
    }),
    Object.freeze({
      component: 'common_risk_exit',
      why: '在状态规则之外保留统一的风险退出。',
      risk: '统一退出可能不适合每一种状态。',
    }),
  ]),
});

function evidenceFor(family, caseLibrary) {
  const cases = Array.isArray(caseLibrary?.index?.cases) ? caseLibrary.index.cases : [];
  const item = cases.find(candidate => candidate?.family === family);
  if (!item) return null;
  return {
    id: item.id,
    role: item.role,
    lesson: item.lesson,
    evidenceDate: item.evidenceDate,
  };
}

export function suggestComplements(spec = {}, caseLibrary = {}) {
  const family = spec?.family || null;
  if (!CASE_FAMILIES.includes(family)) {
    return {
      family,
      evidenceCase: null,
      suggestions: [],
      warnings: [{
        code: 'MECHANISM_FAMILY_UNKNOWN',
        message: '策略家族未知；请先明确趋势、均值回归、突破或状态切换。',
      }],
    };
  }

  const evidenceCase = evidenceFor(family, caseLibrary);
  return {
    family,
    evidenceCase,
    suggestions: COMPLEMENTS[family].map(item => ({ ...item })),
    warnings: evidenceCase ? [] : [{
      code: 'CASE_EVIDENCE_MISSING',
      message: `案例库缺少 ${family} 证据；以下建议仅为通用机制提示。`,
    }],
  };
}
