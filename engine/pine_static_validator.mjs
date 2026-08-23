function issue(code, path, message, risk = null) {
  return { code, path, message, ...(risk ? { risk } : {}) };
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceLines(source) {
  return source
    .split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('//'));
}

const ROLLING_HISTORY_CALL = /\bta\.(lowest|highest)\s*\(/g;

function findConditionalRollingCalls(source) {
  const scopes = [];
  const findings = [];
  const lines = String(source || '').split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const code = lines[index].replace(/\/\/.*$/, '');
    if (!code.trim()) continue;
    const indent = (code.match(/^[\t ]*/) || [''])[0].replace(/\t/g, '    ').length;
    while (scopes.length && indent <= scopes.at(-1).indent) scopes.pop();

    const trimmed = code.trim();
    const calls = [...trimmed.matchAll(ROLLING_HISTORY_CALL)];
    const conditionalExpression = trimmed.includes('?');
    const deferredConditionalHeader = /^else\s+if\b/.test(trimmed);
    if (calls.length && (conditionalExpression || deferredConditionalHeader || scopes.some(scope => scope.conditional))) {
      for (const call of calls) findings.push({ functionName: `ta.${call[1]}`, line: index + 1 });
    }

    if (/^(?:if\b|else(?:\s+if\b)?|for\b|while\b|switch\b)/.test(trimmed)) {
      scopes.push({ indent, conditional: true });
    }
  }

  return findings;
}

export function validatePineStrategy(source, { inputMap = [] } = {}) {
  const errors = [];
  const warnings = [];
  const text = typeof source === 'string' ? source : '';
  if (!text.trim()) errors.push(issue('PINE_STATIC_INVALID', 'source', 'Pine source is empty'));

  const versions = [...text.matchAll(/^\s*\/\/@version\s*=\s*(\d+)\s*$/gm)].map(match => Number(match[1]));
  if (versions.length !== 1 || versions[0] !== 6) {
    errors.push(issue('PINE_STATIC_INVALID', 'version', 'Pine source requires exactly one //@version=6 declaration'));
  }

  const lines = sourceLines(text);
  const declarationLines = lines.filter(line => /\bstrategy\s*\(/.test(line));
  const strategyDeclarations = declarationLines.length;
  if (strategyDeclarations !== 1) {
    errors.push(issue('PINE_STATIC_INVALID', 'strategy.declaration', 'Pine source requires exactly one strategy() declaration'));
  }
  const declaration = declarationLines[0] || '';
  const strategyDeclarationSingleLine = strategyDeclarations === 1 && declaration.includes(')');
  if (strategyDeclarations === 1 && !strategyDeclarationSingleLine) {
    errors.push(issue('PINE_STATIC_INVALID', 'strategy.declaration', 'strategy() declaration must remain on one line'));
  }

  const requiredFields = [
    'pyramiding',
    'default_qty_type',
    'default_qty_value',
    'commission_type',
    'commission_value',
    'slippage',
    'process_orders_on_close',
  ];
  for (const field of requiredFields) {
    if (!new RegExp(`\\b${field}\\s*=`).test(declaration)) {
      errors.push(issue('PINE_STATIC_INVALID', `strategy.${field}`, `strategy() must explicitly set ${field}`));
    }
  }

  if (/\blookahead\s*=\s*barmerge\.lookahead_on\b/.test(text)) {
    errors.push(issue('PINE_STATIC_INVALID', 'repaint.lookahead', 'lookahead_on exposes future higher-timeframe data', 'lookahead_on'));
  }
  if (/\[\s*-\d+\s*\]/.test(text)) {
    errors.push(issue('PINE_STATIC_INVALID', 'repaint.history_index', 'negative history index is not allowed', 'negative_history_index'));
  }
  const conditionalRollingCalls = findConditionalRollingCalls(text);
  if (conditionalRollingCalls.length) {
    const locations = conditionalRollingCalls
      .slice(0, 5)
      .map(call => `${call.functionName} line ${call.line}`)
      .join(', ');
    errors.push(issue(
      'PINE_STATIC_INVALID',
      'state.conditional_rolling',
      `Rolling history functions must run on every bar before conditional state reads: ${locations}`,
      'conditional_rolling',
    ));
  }

  const requestSecurityCalls = countMatches(text, /\brequest\.security\s*\(/g);
  const pivotCalls = countMatches(text, /\bta\.pivot(?:high|low)\s*\(/g);
  const calcOnOrderFills = /\bcalc_on_order_fills\s*=\s*true\b/.test(declaration);
  const calcOnEveryTick = /\bcalc_on_every_tick\s*=\s*true\b/.test(declaration);
  if (requestSecurityCalls) {
    warnings.push(issue('PINE_REVIEW_REQUIRED', 'repaint.request_security', `${requestSecurityCalls} request.security call(s) require timeframe and confirmation review`, 'request_security'));
  }
  if (pivotCalls) {
    warnings.push(issue('PINE_REVIEW_REQUIRED', 'repaint.pivot', `${pivotCalls} pivot call(s) require right-bar confirmation review`, 'pivot'));
  }
  if (calcOnOrderFills) {
    warnings.push(issue('PINE_REVIEW_REQUIRED', 'execution.calc_on_order_fills', 'calc_on_order_fills=true requires bias review', 'calc_on_order_fills'));
  }
  if (calcOnEveryTick) {
    warnings.push(issue('PINE_REVIEW_REQUIRED', 'execution.calc_on_every_tick', 'calc_on_every_tick=true changes realtime execution semantics', 'calc_on_every_tick'));
  }

  let mappedInputs = 0;
  for (const input of Array.isArray(inputMap) ? inputMap : []) {
    const title = String(input?.title || '');
    const pattern = new RegExp(`\\binput\\.[a-z]+\\s*\\([^\\n]*["']${regexEscape(title)}["']`);
    if (title && pattern.test(text)) mappedInputs++;
    else errors.push(issue('PINE_STATIC_INVALID', `inputs.${title || '<missing-title>'}`, `Pine input is missing for ${title || input?.path || 'unknown mapping'}`));
  }

  return {
    errors: [...new Map(errors.map(error => [`${error.code}|${error.path}|${error.message}`, error])).values()],
    warnings: [...new Map(warnings.map(warning => [`${warning.code}|${warning.path}|${warning.message}`, warning])).values()],
    facts: {
      version: versions.length === 1 ? versions[0] : null,
      strategyDeclarations,
      strategyDeclarationSingleLine,
      processOrdersOnClose: /\bprocess_orders_on_close\s*=\s*true\b/.test(declaration),
      calcOnOrderFills,
      calcOnEveryTick,
      requestSecurityCalls,
      pivotCalls,
      mappedInputs,
    },
  };
}
