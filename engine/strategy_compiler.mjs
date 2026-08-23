import { compileExpression, compileIndicator } from './strategy_components.mjs';
import { validatePineStrategy } from './pine_static_validator.mjs';
import { normalizeStrategySpec, validateStrategySpec } from './strategy_spec.mjs';

function compilerError(code, message, details = []) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function pineString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}

function number(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(10)));
}

function riskInput(key, defaultValue, title) {
  const variable = key === 'stopLossPct' ? 'stop_loss_pct' : 'take_profit_pct';
  return {
    path: `exit.${key}`,
    title,
    variable,
    type: 'float',
    defaultValue,
    declaration: `${variable} = input.float(${number(defaultValue)}, "${title}", minval=0.0001)`,
  };
}

export function compileStrategy(input) {
  const validation = validateStrategySpec(input);
  if (validation.errors.length) {
    const code = validation.errors.some(error => error.code === 'UNSUPPORTED_COMPONENT')
      ? 'UNSUPPORTED_COMPONENT'
      : 'SPEC_INVALID';
    throw compilerError(code, validation.errors[0].message, validation.errors);
  }
  if (validation.blockingAmbiguities.length) {
    throw compilerError('SPEC_AMBIGUOUS', 'Strategy Spec has blocking ambiguities', validation.blockingAmbiguities);
  }

  const spec = normalizeStrategySpec(input);
  const components = spec.indicators.map(compileIndicator);
  const context = new Map(spec.indicators.map((indicator, index) => [indicator.id, components[index].outputs]));
  const inputMap = components.flatMap(component => component.inputs.map(input => ({ ...input })));
  const riskInputs = [];
  if (spec.exit.stopLossPct != null) riskInputs.push(riskInput('stopLossPct', spec.exit.stopLossPct, 'Stop Loss %'));
  if (spec.exit.takeProfitPct != null) riskInputs.push(riskInput('takeProfitPct', spec.exit.takeProfitPct, 'Take Profit %'));
  inputMap.push(...riskInputs);

  const entrySignal = compileExpression(spec.entry.signal, context);
  const enabledFilters = spec.entry.filters.filter(filter => filter.enabled).map(filter => compileExpression(filter.condition, context));
  const entryFilters = enabledFilters.length ? (enabledFilters.length === 1 ? enabledFilters[0] : `(${enabledFilters.join(' and ')})`) : 'true';
  const exitSignal = compileExpression(spec.exit.signal, context);

  const header = `strategy("${pineString(spec.title)}", overlay=true, pyramiding=0, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=${number(spec.position.sizePct)}, commission_type=strategy.commission.percent, commission_value=${number(spec.costs.commissionPct)}, slippage=${spec.costs.slippageTicks}, process_orders_on_close=true, calc_on_order_fills=false)`;
  const lines = [
    '//@version=6',
    header,
    '',
    '// Generated from reviewed Strategy Spec v1.',
    ...components.flatMap((component, index) => [component.code, index === components.length - 1 ? '' : '']),
    ...riskInputs.map(input => input.declaration),
    ...(riskInputs.length ? [''] : []),
    `entry_signal = ${entrySignal}`,
    `entry_filters = ${entryFilters}`,
    'entry_condition = entry_signal and entry_filters',
    `exit_signal = ${exitSignal}`,
    '',
    'if entry_condition and strategy.position_size == 0',
    '    strategy.entry("Long", strategy.long)',
    '',
    'if exit_signal and strategy.position_size > 0',
    '    strategy.close("Long", comment="Signal exit")',
  ];

  if (riskInputs.length) {
    lines.push(
      '',
      `stop_price = ${spec.exit.stopLossPct != null ? 'strategy.position_avg_price * (1 - stop_loss_pct / 100)' : 'na'}`,
      `target_price = ${spec.exit.takeProfitPct != null ? 'strategy.position_avg_price * (1 + take_profit_pct / 100)' : 'na'}`,
      'if strategy.position_size > 0',
      '    strategy.exit("Risk exit", "Long", stop=stop_price, limit=target_price)',
    );
  }

  const source = `${lines.join('\n')}\n`;
  const staticValidation = validatePineStrategy(source, { spec, inputMap });
  if (staticValidation.errors.length) {
    throw compilerError('PINE_STATIC_INVALID', staticValidation.errors[0].message, staticValidation.errors);
  }
  return {
    source,
    inputMap,
    warnings: [...validation.warnings, ...staticValidation.warnings],
  };
}
