export const BUILT_IN_DEFAULT_SYMBOLS = Object.freeze(['NASDAQ:QQQ', 'SSE:510300']);
export const BUILT_IN_RECOMMENDED_THIRD_SYMBOL = 'AMEX:SPY';
export const BUILT_IN_ROBUSTNESS_SYMBOLS = Object.freeze([
  'NASDAQ:QQQ',
  BUILT_IN_RECOMMENDED_THIRD_SYMBOL,
  'SSE:510300',
]);
export const BUILT_IN_DEFAULT_TIMEFRAME = 'D';
export const BUILT_IN_DEFAULT_COSTS = Object.freeze({
  commission: '0.15%',
  slippage: '2 ticks',
});

const EMPTY_EVIDENCE = Object.freeze([]);

const baselineCommand = (fixture) =>
  `node "$ENGINE" "${fixture}" --symbols ${BUILT_IN_DEFAULT_SYMBOLS.join(',')} --timeframe ${BUILT_IN_DEFAULT_TIMEFRAME} --commission 0.15 --slippage 2`;

const reportCommand = 'node "$SKILL_DIR/engine/report.mjs" <data.json>';

function makeRecipe({ fixture, scan }) {
  return Object.freeze({
    defaultSymbols: BUILT_IN_DEFAULT_SYMBOLS,
    defaultTimeframe: BUILT_IN_DEFAULT_TIMEFRAME,
    steps: Object.freeze([
      {
        id: 'baseline',
        label: 'Baseline on default symbols',
        optional: false,
        command: baselineCommand(fixture),
        explains: 'Run the unchanged standard strategy on QQQ and 510300 with declared costs.',
      },
      {
        id: 'compare',
        label: 'Compare against buy-and-hold',
        optional: false,
        explains: 'Read strategy return, B&H, alpha, drawdown, trades, PF, and win rate from the same run.',
      },
      {
        id: 'scan',
        label: 'Bounded parameter scan',
        optional: true,
        command: scan,
        explains: 'Only run when the user wants parameter research; keep the budget explicit.',
      },
      {
        id: 'validate',
        label: 'Validate fixed Top-1 parameters',
        optional: true,
        explains: 'Apply one fixed candidate to QQQ, SPY, and 510300 without per-market retuning.',
      },
      {
        id: 'report',
        label: 'Generate HTML report',
        optional: false,
        command: reportCommand,
        explains: 'Render the explanation, Strategy Spec, current TradingView evidence, and limits.',
      },
    ]),
  });
}

export const builtInStrategies = Object.freeze([
  {
    id: 'macd-signal-cross',
    name: 'MACD Signal Cross',
    family: 'momentum',
    description: 'A momentum strategy that enters when the MACD line crosses above the signal line.',
    defaultSymbols: BUILT_IN_DEFAULT_SYMBOLS,
    robustnessSymbols: BUILT_IN_ROBUSTNESS_SYMBOLS,
    defaultTimeframe: BUILT_IN_DEFAULT_TIMEFRAME,
    costs: BUILT_IN_DEFAULT_COSTS,
    pineFixture: 'fixtures/smoke_macd_strategy.pine',
    parameters: Object.freeze([
      { name: 'Fast Length', default: 12, range: [8, 12, 16], effect: 'Shorter reacts faster but whipsaws more.' },
      { name: 'Slow Length', default: 26, range: [21, 26, 34], effect: 'Longer smooths trend but lags reversals.' },
      { name: 'Signal Length', default: 9, range: [5, 9, 12], effect: 'Shorter confirms sooner; longer filters more noise.' },
      { name: 'Direction', default: 'Long Only', range: ['Long Only', 'Both'], effect: 'Direction changes exposure and must be reviewed explicitly.' },
    ]),
    worksWhen: 'Momentum continues after a directional impulse.',
    failsWhen: 'Sideways markets repeatedly cross the signal line.',
    recipe: makeRecipe({
      fixture: 'fixtures/smoke_macd_strategy.pine',
      scan: 'node "$ENGINE" "fixtures/smoke_macd_strategy.pine" --symbol NASDAQ:QQQ --scan "Fast Length=8..16:4" --scan "Signal Length=5..13:4" --commission 0.15 --slippage 2 --budget 9',
    }),
    snapshots: EMPTY_EVIDENCE,
    lightTuning: EMPTY_EVIDENCE,
  },
  {
    id: 'bollinger-mean-reversion',
    name: 'Bollinger Mean Reversion',
    family: 'mean-reversion',
    description: 'A mean-reversion strategy that enters when price recovers from the lower band.',
    defaultSymbols: BUILT_IN_DEFAULT_SYMBOLS,
    robustnessSymbols: BUILT_IN_ROBUSTNESS_SYMBOLS,
    defaultTimeframe: BUILT_IN_DEFAULT_TIMEFRAME,
    costs: BUILT_IN_DEFAULT_COSTS,
    pineFixture: 'fixtures/smoke_bollinger_strategy.pine',
    parameters: Object.freeze([
      { name: 'Length', default: 20, range: [14, 20, 30], effect: 'Longer bands move slower and usually trade less.' },
      { name: 'Multiplier', default: 2, range: [1.5, 2, 2.5], effect: 'Wider bands require a more extreme deviation.' },
      { name: 'Direction', default: 'Long Only', range: ['Long Only', 'Both'], effect: 'Two-way exposure adds short-side risk.' },
    ]),
    worksWhen: 'Prices overshoot and revert toward their recent distribution.',
    failsWhen: 'Strong trends keep walking one side of the band.',
    recipe: makeRecipe({
      fixture: 'fixtures/smoke_bollinger_strategy.pine',
      scan: 'node "$ENGINE" "fixtures/smoke_bollinger_strategy.pine" --symbol NASDAQ:QQQ --scan "Length=14..30:8" --scan "Multiplier=1.5..2.5:0.5" --commission 0.15 --slippage 2 --budget 9',
    }),
    snapshots: EMPTY_EVIDENCE,
    lightTuning: EMPTY_EVIDENCE,
  },
  {
    id: 'moving-average-cross',
    name: 'Moving Average Cross',
    family: 'trend',
    description: 'A trend-following strategy that enters when a fast EMA crosses above a slow EMA.',
    defaultSymbols: BUILT_IN_DEFAULT_SYMBOLS,
    robustnessSymbols: BUILT_IN_ROBUSTNESS_SYMBOLS,
    defaultTimeframe: BUILT_IN_DEFAULT_TIMEFRAME,
    costs: BUILT_IN_DEFAULT_COSTS,
    pineFixture: 'fixtures/standard_ma_cross_strategy.pine',
    parameters: Object.freeze([
      { name: 'Fast Length', default: 20, range: [10, 20, 50], effect: 'Shorter reacts earlier but creates more false crosses.' },
      { name: 'Slow Length', default: 100, range: [50, 100, 200], effect: 'Longer filters noise but responds later.' },
      { name: 'Direction', default: 'Long Only', range: ['Long Only', 'Both'], effect: 'Direction must match the reviewed Strategy Spec.' },
    ]),
    worksWhen: 'A crossover is followed by a sustained directional move.',
    failsWhen: 'Range-bound markets produce repeated crosses without follow-through.',
    recipe: makeRecipe({
      fixture: 'fixtures/standard_ma_cross_strategy.pine',
      scan: 'node "$ENGINE" "fixtures/standard_ma_cross_strategy.pine" --symbol NASDAQ:QQQ --scan "Fast Length=10..50:20" --scan "Slow Length=50..200:75" --commission 0.15 --slippage 2 --budget 9',
    }),
    snapshots: EMPTY_EVIDENCE,
    lightTuning: EMPTY_EVIDENCE,
  },
]);

export function listBuiltInStrategies() {
  return builtInStrategies.map((strategy) => ({ ...strategy }));
}

export function getBuiltInStrategy(id) {
  return builtInStrategies.find((strategy) => strategy.id === id) || null;
}
