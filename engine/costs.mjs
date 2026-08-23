const COST_KEYS = new Set(['commission_type', 'commission_value', 'slippage']);

function hasValue(v) {
  return v !== null && v !== undefined && v !== '';
}

function findStrategyHeader(code) {
  const m = /\bstrategy\s*\(/.exec(code);
  if (!m) return null;
  let depth = 0, quote = null, escaped = false;
  for (let i = m.index; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { start: m.index, end: i + 1, header: code.slice(m.index, i + 1) };
    }
    if (ch === '\n' && depth > 0) return { multiline: true };
  }
  return null;
}

function splitTopLevelArgs(s) {
  const args = [];
  let start = 0, depth = 0, quote = null, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      args.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = s.slice(start).trim();
  if (last) args.push(last);
  return args;
}

function argKey(arg) {
  const m = arg.match(/^([A-Za-z_]\w*)\s*=/);
  return m ? m[1] : null;
}

function commissionTypeExpr(type) {
  const suffix = type || 'percent';
  return `strategy.commission.${suffix}`;
}

export function buildCostSummary(opts = {}) {
  const out = {};
  if (hasValue(opts.commission)) out.commission = `${opts.commission}%`;
  if (hasValue(opts.slippage)) out.slippage = `${opts.slippage} ticks`;
  return Object.keys(out).length ? out : null;
}

export function patchStrategyCosts(code, opts = {}) {
  const requested = hasValue(opts.commission) || hasValue(opts.slippage);
  if (!requested) return { code, warnings: [], errors: [], costs: null };

  const found = findStrategyHeader(code);
  if (found?.multiline) {
    return {
      code,
      warnings: [],
      errors: ['MULTILINE_STRATEGY_HEADER: 使用成本参数前，请把 strategy(...) 声明整理为单行'],
      costs: buildCostSummary(opts),
    };
  }
  if (!found) {
    return {
      code,
      warnings: ['未找到单行 strategy(...) 头，已跳过手续费/滑点补丁'],
      errors: [],
      costs: buildCostSummary(opts),
    };
  }

  const open = found.header.indexOf('(');
  const inner = found.header.slice(open + 1, -1);
  const kept = splitTopLevelArgs(inner).filter(a => !COST_KEYS.has(argKey(a)));
  const next = [...kept];

  if (hasValue(opts.commission)) {
    next.push(`commission_type=${commissionTypeExpr(opts.commissionType)}`);
    next.push(`commission_value=${opts.commission}`);
  }
  if (hasValue(opts.slippage)) next.push(`slippage=${opts.slippage}`);

  const patchedHeader = `${found.header.slice(0, open + 1)}${next.join(', ')})`;
  return {
    code: code.slice(0, found.start) + patchedHeader + code.slice(found.end),
    warnings: [],
    errors: [],
    costs: buildCostSummary(opts),
  };
}
