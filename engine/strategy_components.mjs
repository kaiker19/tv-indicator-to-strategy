const RESERVED = new Set([
  'and', 'break', 'by', 'continue', 'else', 'false', 'for', 'if', 'in', 'not', 'or', 'return', 'true', 'var', 'while',
]);

function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Expected finite number, got ${value}`);
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(10)));
}

export function pineIdentifier(value) {
  let id = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!id) throw new Error(`Value does not contain a usable Pine identifier: ${value}`);
  if (/^\d/.test(id) || RESERVED.has(id)) id = `i_${id}`;
  return id;
}

function labelPart(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function inputRecord(indicator, key, type, options = {}) {
  const id = pineIdentifier(indicator.id);
  const variable = `${id}_${pineIdentifier(key)}`;
  const title = `${labelPart(indicator.id)} ${labelPart(key)}`;
  const defaultValue = indicator.params[key];
  const minval = options.minval == null ? '' : `, minval=${formatNumber(options.minval)}`;
  return {
    path: `indicators.${indicator.id}.params.${key}`,
    title,
    variable,
    type,
    defaultValue,
    declaration: `${variable} = input.${type}(${formatNumber(defaultValue)}, "${title}"${minval})`,
  };
}

export function compileIndicator(indicator) {
  const id = pineIdentifier(indicator.id);
  const source = indicator.source;
  const inputs = [];
  let calculation;
  let outputs;

  const lengthInput = () => {
    const input = inputRecord(indicator, 'length', 'int', { minval: 1 });
    inputs.push(input);
    return input.variable;
  };

  if (['sma', 'ema', 'rma', 'rsi'].includes(indicator.kind)) {
    const length = lengthInput();
    calculation = `${id} = ta.${indicator.kind}(${source}, ${length})`;
    outputs = { value: id };
  } else if (indicator.kind === 'atr') {
    const length = lengthInput();
    calculation = `${id} = ta.atr(${length})`;
    outputs = { value: id };
  } else if (indicator.kind === 'highest' || indicator.kind === 'lowest') {
    const length = lengthInput();
    calculation = `${id} = ta.${indicator.kind}(${source}, ${length})[1]`;
    outputs = { value: id };
  } else if (indicator.kind === 'macd') {
    const fast = inputRecord(indicator, 'fastLength', 'int', { minval: 1 });
    const slow = inputRecord(indicator, 'slowLength', 'int', { minval: 1 });
    const signal = inputRecord(indicator, 'signalLength', 'int', { minval: 1 });
    inputs.push(fast, slow, signal);
    outputs = {
      macd: `${id}_macd`,
      signal: `${id}_signal`,
      hist: `${id}_hist`,
    };
    calculation = `[${outputs.macd}, ${outputs.signal}, ${outputs.hist}] = ta.macd(${source}, ${fast.variable}, ${slow.variable}, ${signal.variable})`;
  } else if (indicator.kind === 'bollinger') {
    const length = inputRecord(indicator, 'length', 'int', { minval: 1 });
    const multiplier = inputRecord(indicator, 'multiplier', 'float', { minval: 0.0001 });
    inputs.push(length, multiplier);
    outputs = {
      basis: `${id}_basis`,
      upper: `${id}_upper`,
      lower: `${id}_lower`,
    };
    calculation = `[${outputs.basis}, ${outputs.upper}, ${outputs.lower}] = ta.bb(${source}, ${length.variable}, ${multiplier.variable})`;
  } else {
    throw new Error(`Unsupported indicator kind: ${indicator.kind}`);
  }

  return {
    id,
    inputs,
    outputs,
    code: [...inputs.map(input => input.declaration), calculation].join('\n'),
  };
}

function compileOperand(operand, context) {
  if (Object.prototype.hasOwnProperty.call(operand, 'value')) return formatNumber(operand.value);
  if (Object.prototype.hasOwnProperty.call(operand, 'price')) return operand.price;
  const outputs = context.get(operand.indicator);
  if (!outputs) throw new Error(`Unknown indicator: ${operand.indicator}`);
  const output = operand.output || 'value';
  if (!outputs[output]) throw new Error(`Unknown output ${output} for indicator ${operand.indicator}`);
  return outputs[output];
}

export function compileExpression(expression, context) {
  if (Object.prototype.hasOwnProperty.call(expression, 'all')) {
    return `(${expression.all.map(child => compileExpression(child, context)).join(' and ')})`;
  }
  if (Object.prototype.hasOwnProperty.call(expression, 'any')) {
    return `(${expression.any.map(child => compileExpression(child, context)).join(' or ')})`;
  }
  if (Object.prototype.hasOwnProperty.call(expression, 'not')) {
    return `(not (${compileExpression(expression.not, context)}))`;
  }

  const left = compileOperand(expression.left, context);
  const right = compileOperand(expression.right, context);
  if (expression.op === 'crosses_above') return `ta.crossover(${left}, ${right})`;
  if (expression.op === 'crosses_below') return `ta.crossunder(${left}, ${right})`;
  const operators = {
    greater_than: '>',
    less_than: '<',
    greater_or_equal: '>=',
    less_or_equal: '<=',
  };
  if (!operators[expression.op]) throw new Error(`Unsupported expression op: ${expression.op}`);
  return `(${left} ${operators[expression.op]} ${right})`;
}
