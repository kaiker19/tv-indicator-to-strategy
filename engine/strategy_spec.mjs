export const STRATEGY_SPEC_VERSION = 1;

export const STRATEGY_FAMILIES = Object.freeze([
  'trend',
  'mean_reversion',
  'breakout',
  'state_switching',
  'other',
]);

export const INDICATOR_KINDS = Object.freeze([
  'sma',
  'ema',
  'rma',
  'rsi',
  'macd',
  'bollinger',
  'atr',
  'highest',
  'lowest',
]);

export const PRICE_SOURCES = Object.freeze([
  'open',
  'high',
  'low',
  'close',
  'hl2',
  'hlc3',
  'ohlc4',
]);

const PREDICATES = new Set([
  'crosses_above',
  'crosses_below',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
]);

const OUTPUTS = Object.freeze({
  sma: ['value'],
  ema: ['value'],
  rma: ['value'],
  rsi: ['value'],
  macd: ['macd', 'signal', 'hist'],
  bollinger: ['basis', 'upper', 'lower'],
  atr: ['value'],
  highest: ['value'],
  lowest: ['value'],
});

function issue(code, path, message) {
  return { code, path, message };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeTimeframe(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (/^[DWM]$/.test(raw)) return `1${raw}`;
  return raw;
}

function normalizeArrays(spec) {
  spec.assumptions = Array.isArray(spec.assumptions) ? spec.assumptions : [];
  spec.ambiguities = Array.isArray(spec.ambiguities) ? spec.ambiguities : [];
  if (isObject(spec.entry)) spec.entry.filters = Array.isArray(spec.entry.filters) ? spec.entry.filters : [];
  return spec;
}

export function normalizeStrategySpec(spec) {
  const normalized = normalizeArrays(structuredClone(spec));
  if (isObject(normalized.market)) normalized.market.timeframe = normalizeTimeframe(normalized.market.timeframe);
  return normalized;
}

function validateAmbiguities(spec, errors) {
  const blocking = [];
  if (!Array.isArray(spec.ambiguities)) {
    errors.push(issue('SPEC_INVALID', 'ambiguities', 'ambiguities must be an array'));
    return blocking;
  }
  spec.ambiguities.forEach((item, index) => {
    const path = `ambiguities[${index}]`;
    if (!isObject(item)) {
      errors.push(issue('SPEC_INVALID', path, 'ambiguity must be an object'));
      return;
    }
    if (!hasText(item.field)) errors.push(issue('SPEC_INVALID', `${path}.field`, 'ambiguity field is required'));
    if (!hasText(item.question)) errors.push(issue('SPEC_INVALID', `${path}.question`, 'ambiguity question is required'));
    if (!Array.isArray(item.choices) || item.choices.length < 2 || item.choices.some(choice => !hasText(choice))) {
      errors.push(issue('SPEC_INVALID', `${path}.choices`, 'ambiguity choices require at least two labels'));
    }
    if (!['blocking', 'review'].includes(item.severity)) {
      errors.push(issue('SPEC_INVALID', `${path}.severity`, 'ambiguity severity must be blocking or review'));
    } else if (item.severity === 'blocking') {
      blocking.push(structuredClone(item));
    }
  });
  return blocking;
}

function isCoveredByAmbiguity(path, blocking) {
  return blocking.some(item => item.field === path || item.field.startsWith(`${path}.`) || path.startsWith(`${item.field}.`));
}

function requireValue(value, path, blocking, errors) {
  if (value == null || value === '') {
    if (!isCoveredByAmbiguity(path, blocking)) errors.push(issue('SPEC_INVALID', path, `${path} is required`));
    return false;
  }
  return true;
}

function validateIndicator(indicator, index, ids, errors) {
  const path = `indicators[${index}]`;
  if (!isObject(indicator)) {
    errors.push(issue('SPEC_INVALID', path, 'indicator must be an object'));
    return;
  }
  if (!hasText(indicator.id)) errors.push(issue('SPEC_INVALID', `${path}.id`, 'indicator id is required'));
  else if (ids.has(indicator.id)) errors.push(issue('SPEC_INVALID', `${path}.id`, `duplicate indicator id: ${indicator.id}`));
  else ids.set(indicator.id, indicator);

  if (!INDICATOR_KINDS.includes(indicator.kind)) {
    errors.push(issue('UNSUPPORTED_COMPONENT', `${path}.kind`, `Unsupported indicator kind: ${indicator.kind}`));
  }
  if (!PRICE_SOURCES.includes(indicator.source)) {
    errors.push(issue('UNSUPPORTED_COMPONENT', `${path}.source`, `Unsupported price source: ${indicator.source}`));
  }
  if (!isObject(indicator.params)) {
    errors.push(issue('SPEC_INVALID', `${path}.params`, 'indicator params must be an object'));
    return;
  }

  if (indicator.kind === 'macd') {
    for (const key of ['fastLength', 'slowLength', 'signalLength']) {
      if (!positiveInteger(indicator.params[key])) errors.push(issue('SPEC_INVALID', `${path}.params.${key}`, `${key} must be a positive integer`));
    }
    if (positiveInteger(indicator.params.fastLength) && positiveInteger(indicator.params.slowLength)
      && indicator.params.fastLength >= indicator.params.slowLength) {
      errors.push(issue('SPEC_INVALID', `${path}.params.fastLength`, 'fastLength must be less than slowLength'));
    }
    return;
  }

  if (!positiveInteger(indicator.params.length)) {
    errors.push(issue('SPEC_INVALID', `${path}.params.length`, 'length must be a positive integer'));
  }
  if (indicator.kind === 'bollinger' && !positiveNumber(indicator.params.multiplier)) {
    errors.push(issue('SPEC_INVALID', `${path}.params.multiplier`, 'multiplier must be positive'));
  }
}

function validateOperand(operand, path, indicators, errors) {
  if (!isObject(operand)) {
    errors.push(issue('SPEC_INVALID', path, 'operand must be an object'));
    return;
  }
  const forms = ['indicator', 'price', 'value'].filter(key => Object.prototype.hasOwnProperty.call(operand, key));
  if (forms.length !== 1) {
    errors.push(issue('SPEC_INVALID', path, 'operand must contain exactly one of indicator, price, or value'));
    return;
  }
  if (forms[0] === 'value') {
    if (typeof operand.value !== 'number' || !Number.isFinite(operand.value)) {
      errors.push(issue('SPEC_INVALID', `${path}.value`, 'operand value must be finite'));
    }
    return;
  }
  if (forms[0] === 'price') {
    if (!PRICE_SOURCES.includes(operand.price)) {
      errors.push(issue('UNSUPPORTED_COMPONENT', `${path}.price`, `Unsupported price source: ${operand.price}`));
    }
    return;
  }

  const indicator = indicators.get(operand.indicator);
  if (!indicator) {
    errors.push(issue('SPEC_INVALID', `${path}.indicator`, `Unknown indicator: ${operand.indicator}`));
    return;
  }
  const outputs = OUTPUTS[indicator.kind] || [];
  if (outputs.length > 1 && !hasText(operand.output)) {
    errors.push(issue('SPEC_INVALID', `${path}.output`, `${indicator.kind} requires an output: ${outputs.join(', ')}`));
  } else if (operand.output != null && !outputs.includes(operand.output)) {
    errors.push(issue('UNSUPPORTED_COMPONENT', `${path}.output`, `Unsupported ${indicator.kind} output: ${operand.output}`));
  }
}

function validateExpression(expression, path, indicators, errors) {
  if (!isObject(expression)) {
    errors.push(issue('SPEC_INVALID', path, 'expression must be an object'));
    return;
  }
  const groupKeys = ['all', 'any', 'not'].filter(key => Object.prototype.hasOwnProperty.call(expression, key));
  if (groupKeys.length) {
    if (groupKeys.length !== 1 || Object.prototype.hasOwnProperty.call(expression, 'op')) {
      errors.push(issue('SPEC_INVALID', path, 'expression must use one group or one predicate'));
      return;
    }
    const key = groupKeys[0];
    if (key === 'not') {
      validateExpression(expression.not, `${path}.not`, indicators, errors);
      return;
    }
    if (!Array.isArray(expression[key]) || expression[key].length === 0) {
      errors.push(issue('SPEC_INVALID', `${path}.${key}`, `${key} requires at least one expression`));
      return;
    }
    expression[key].forEach((child, index) => validateExpression(child, `${path}.${key}[${index}]`, indicators, errors));
    return;
  }

  if (!PREDICATES.has(expression.op)) {
    errors.push(issue('UNSUPPORTED_COMPONENT', `${path}.op`, `Unsupported expression op: ${expression.op}`));
    return;
  }
  validateOperand(expression.left, `${path}.left`, indicators, errors);
  validateOperand(expression.right, `${path}.right`, indicators, errors);
}

function validateEntry(entry, blocking, indicators, errors) {
  if (!requireValue(entry, 'entry', blocking, errors)) return;
  if (!isObject(entry)) {
    errors.push(issue('SPEC_INVALID', 'entry', 'entry must be an object'));
    return;
  }
  if (requireValue(entry.signal, 'entry.signal', blocking, errors)) {
    validateExpression(entry.signal, 'entry.signal', indicators, errors);
  }
  if (!Array.isArray(entry.filters)) {
    errors.push(issue('SPEC_INVALID', 'entry.filters', 'entry.filters must be an array'));
    return;
  }
  const ids = new Set();
  entry.filters.forEach((filter, index) => {
    const path = `entry.filters[${index}]`;
    if (!isObject(filter)) {
      errors.push(issue('SPEC_INVALID', path, 'filter must be an object'));
      return;
    }
    if (!hasText(filter.id)) errors.push(issue('SPEC_INVALID', `${path}.id`, 'filter id is required'));
    else if (ids.has(filter.id)) errors.push(issue('SPEC_INVALID', `${path}.id`, `duplicate filter id: ${filter.id}`));
    else ids.add(filter.id);
    if (typeof filter.enabled !== 'boolean') errors.push(issue('SPEC_INVALID', `${path}.enabled`, 'filter enabled must be boolean'));
    validateExpression(filter.condition, `${path}.condition`, indicators, errors);
  });
}

function validateExit(exit, blocking, indicators, errors) {
  if (!requireValue(exit, 'exit', blocking, errors)) return;
  if (!isObject(exit)) {
    errors.push(issue('SPEC_INVALID', 'exit', 'exit must be an object'));
    return;
  }
  if (requireValue(exit.signal, 'exit.signal', blocking, errors)) {
    validateExpression(exit.signal, 'exit.signal', indicators, errors);
  }
  for (const key of ['stopLossPct', 'takeProfitPct']) {
    if (exit[key] != null && !positiveNumber(exit[key])) {
      errors.push(issue('SPEC_INVALID', `exit.${key}`, `${key} must be positive`));
    }
  }
}

export function validateStrategySpec(input) {
  const errors = [];
  const warnings = [];
  if (!isObject(input)) {
    return { errors: [issue('SPEC_INVALID', '', 'spec must be an object')], warnings, blockingAmbiguities: [] };
  }
  const spec = normalizeArrays(structuredClone(input));
  const blockingAmbiguities = validateAmbiguities(spec, errors);

  if (spec.schemaVersion !== STRATEGY_SPEC_VERSION) errors.push(issue('SPEC_INVALID', 'schemaVersion', 'schemaVersion must be 1'));
  for (const key of ['title', 'summary', 'sourceIntent']) {
    if (!hasText(spec[key])) errors.push(issue('SPEC_INVALID', key, `${key} is required`));
  }
  if (!STRATEGY_FAMILIES.includes(spec.family)) {
    errors.push(issue('UNSUPPORTED_COMPONENT', 'family', `Unsupported strategy family: ${spec.family}`));
  }

  if (!requireValue(spec.market, 'market', blockingAmbiguities, errors)) {
    // The matching ambiguity already carries the missing decision.
  } else if (!isObject(spec.market)) {
    errors.push(issue('SPEC_INVALID', 'market', 'market must be an object'));
  } else {
    requireValue(spec.market.symbol, 'market.symbol', blockingAmbiguities, errors);
    if (requireValue(spec.market.timeframe, 'market.timeframe', blockingAmbiguities, errors)
      && !/^\d+[DWM]$/.test(normalizeTimeframe(spec.market.timeframe))) {
      errors.push(issue('SPEC_INVALID', 'market.timeframe', 'timeframe must be daily, weekly, or monthly'));
    }
  }

  if (!requireValue(spec.execution, 'execution', blockingAmbiguities, errors)) {
    // Covered by a blocking ambiguity.
  } else if (!isObject(spec.execution)) {
    errors.push(issue('SPEC_INVALID', 'execution', 'execution must be an object'));
  } else {
    if (spec.execution.timing !== 'bar_close') errors.push(issue('UNSUPPORTED_COMPONENT', 'execution.timing', 'Only bar_close timing is supported'));
    if (spec.execution.side !== 'long_only') errors.push(issue('UNSUPPORTED_COMPONENT', 'execution.side', 'Only long_only strategies are supported'));
    if (spec.execution.pyramiding !== 0) errors.push(issue('UNSUPPORTED_COMPONENT', 'execution.pyramiding', 'pyramiding must be 0'));
    if (spec.execution.processOrdersOnClose !== true) errors.push(issue('SPEC_INVALID', 'execution.processOrdersOnClose', 'processOrdersOnClose must be true'));
  }

  if (!requireValue(spec.costs, 'costs', blockingAmbiguities, errors)) {
    // Covered by a blocking ambiguity.
  } else if (!isObject(spec.costs)) {
    errors.push(issue('SPEC_INVALID', 'costs', 'costs must be an object'));
  } else {
    if (typeof spec.costs.commissionPct !== 'number' || !Number.isFinite(spec.costs.commissionPct) || spec.costs.commissionPct < 0) {
      errors.push(issue('SPEC_INVALID', 'costs.commissionPct', 'commissionPct must be a non-negative number'));
    }
    if (!Number.isInteger(spec.costs.slippageTicks) || spec.costs.slippageTicks < 0) {
      errors.push(issue('SPEC_INVALID', 'costs.slippageTicks', 'slippageTicks must be a non-negative integer'));
    }
  }

  if (!requireValue(spec.position, 'position', blockingAmbiguities, errors)) {
    // Covered by a blocking ambiguity.
  } else if (!isObject(spec.position) || !positiveNumber(spec.position.sizePct) || spec.position.sizePct > 100) {
    errors.push(issue('SPEC_INVALID', 'position.sizePct', 'sizePct must be greater than 0 and at most 100'));
  }

  const indicators = new Map();
  if (!Array.isArray(spec.indicators) || spec.indicators.length === 0) {
    errors.push(issue('SPEC_INVALID', 'indicators', 'indicators requires at least one component'));
  } else {
    spec.indicators.forEach((indicator, index) => validateIndicator(indicator, index, indicators, errors));
  }
  validateEntry(spec.entry, blockingAmbiguities, indicators, errors);
  validateExit(spec.exit, blockingAmbiguities, indicators, errors);

  if (!Array.isArray(spec.assumptions) || spec.assumptions.some(value => !hasText(value))) {
    errors.push(issue('SPEC_INVALID', 'assumptions', 'assumptions must contain text labels'));
  }
  const reviewAmbiguities = spec.ambiguities.filter(item => item?.severity === 'review');
  if (reviewAmbiguities.length) warnings.push(issue('SPEC_AMBIGUOUS', 'ambiguities', `${reviewAmbiguities.length} review ambiguity item(s) remain`));

  return {
    errors: [...new Map(errors.map(error => [`${error.code}|${error.path}|${error.message}`, error])).values()],
    warnings,
    blockingAmbiguities,
  };
}
