function parseScalar(value) {
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export function parseInputAssignment(spec) {
  const eq = String(spec || '').indexOf('=');
  if (eq <= 0) throw new Error(`expected Name=value, got: ${spec || '(empty)'}`);
  const name = spec.slice(0, eq).trim();
  if (!name) throw new Error(`expected Name=value, got: ${spec}`);
  return [name, parseScalar(spec.slice(eq + 1))];
}

function quotedValueAt(source, start) {
  let index = start;
  while (/\s/.test(source[index] || '')) index++;
  const quote = source[index];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (index += 1; index < source.length; index++) {
    const character = source[index];
    if (character === '\\' && index + 1 < source.length) {
      value += source[index + 1];
      index++;
    } else if (character === quote) {
      return value;
    } else {
      value += character;
    }
  }
  return null;
}

function inputTitle(args) {
  const named = /\btitle\s*=\s*/g.exec(args);
  if (named) return quotedValueAt(args, named.index + named[0].length);
  const comma = firstTopLevelComma(args, 0);
  return comma >= 0 ? quotedValueAt(args, comma + 1) : null;
}

export function buildInputTitleMap(pineSource) {
  const map = {};
  const callRe = /\binput(?:\.\w+)?\s*\(((?:[^()]|\([^()]*\))*)\)/g;
  let match;
  let index = 0;
  while ((match = callRe.exec(String(pineSource || ''))) !== null) {
    const args = match[1];
    const title = inputTitle(args);
    if (title) map[title] = `in_${index}`;
    index++;
  }
  return map;
}

function pineLiteral(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new TypeError(`unsupported Pine input default: ${String(value)}`);
}

function firstTopLevelComma(source, start) {
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[' || character === '{') depth += 1;
    else if (character === ')' || character === ']' || character === '}') depth -= 1;
    else if (character === ',' && depth === 0) return index;
  }
  return -1;
}

export function solidifySourceInputValues(pineSource, expected) {
  const pending = new Map(Object.entries(expected || {}));
  if (!pending.size) return String(pineSource || '');
  const lines = String(pineSource || '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const call = line.match(/\binput(?:\.\w+)?\s*\(/);
    if (!call) continue;
    const opening = call.index + call[0].lastIndexOf('(');
    const args = line.slice(opening + 1);
    const title = inputTitle(args);
    if (!title || !pending.has(title)) continue;
    const comma = firstTopLevelComma(line, opening + 1);
    if (comma < 0) throw new Error(`cannot solidify Pine input without a default separator: ${title}`);
    lines[index] = `${line.slice(0, opening + 1)}${pineLiteral(pending.get(title))}${line.slice(comma)}`;
    pending.delete(title);
  }
  if (pending.size) throw new Error(`Pine source inputs not found: ${[...pending.keys()].join(', ')}`);
  return lines.join('\n');
}

function printable(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function verifySourceInputValues({ pineSource, expected, actualInputs }) {
  const declared = expected || {};
  if (!Object.keys(declared).length) return {};
  if (!Array.isArray(actualInputs) || !actualInputs.length) {
    throw new Error('SOURCE_INPUT_MISMATCH: live input values unavailable');
  }

  const titleMap = buildInputTitleMap(pineSource);
  const actualById = new Map(actualInputs.map(item => [item?.id, item?.value]));
  const verified = {};
  for (const [name, expectedValue] of Object.entries(declared)) {
    const id = /^in_\d+$/.test(name) ? name : titleMap[name];
    if (!id || !actualById.has(id)) {
      throw new Error(`SOURCE_INPUT_MISMATCH: ${name} not found`);
    }
    const actualValue = actualById.get(id);
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      throw new Error(`SOURCE_INPUT_MISMATCH: ${name} expected ${printable(expectedValue)}, actual ${printable(actualValue)}`);
    }
    verified[name] = expectedValue;
  }
  return verified;
}

export function mergeProvenInputs(sourceInputs, runtimeInputs) {
  return { ...(sourceInputs || {}), ...(runtimeInputs || {}) };
}
