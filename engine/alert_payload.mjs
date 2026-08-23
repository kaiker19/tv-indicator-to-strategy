const CONDITION_TYPE_MAP = Object.freeze({
  crossing: 'cross',
  cross: 'cross',
  greater_than: 'greater',
  greater: 'greater',
  above: 'greater',
  '>': 'greater',
  less_than: 'less',
  less: 'less',
  below: 'less',
  '<': 'less',
});

const STRATEGY_ALERT_MODE_MAP = Object.freeze({
  strategy: 'strategy',
  order_fills: 'strategy',
  alerts: 'alerts',
  alert_calls: 'alerts',
  strategy_and_alerts: 'strategy_and_alerts',
  both: 'strategy_and_alerts',
});

export function normalizeAlertCondition(condition = 'crossing') {
  const key = String(condition || 'crossing').trim().toLowerCase();
  return CONDITION_TYPE_MAP[key] || 'cross';
}

export function normalizeStrategyAlertMode(mode = 'strategy') {
  const key = String(mode || 'strategy').trim().toLowerCase();
  const normalized = STRATEGY_ALERT_MODE_MAP[key];
  if (!normalized) {
    throw new Error(`strategy alert mode must be strategy, alerts, or strategy_and_alerts; got: ${mode}`);
  }
  return normalized;
}

export function validateWebhookUrl(url = null) {
  if (url == null || url === '') return null;
  const raw = String(url).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`webhook must be a valid http(s) URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`webhook must be an http(s) URL: ${raw}`);
  }
  return parsed.toString();
}

function finitePrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`price must be a finite number, got: ${value}`);
  return n;
}

function defaultMessage(symbol, condition, price) {
  const short = String(symbol).split(':').pop();
  const verb = condition === 'greater' ? 'above' : condition === 'less' ? 'below' : 'crossing';
  return `${short} ${verb} ${price}`;
}

function normalizedSymbol(symbol) {
  const sym = String(symbol || '').trim();
  if (!sym) throw new Error('symbol is required for TradingView alert payload');
  return sym;
}

function defaultStrategyMessage() {
  return [
    'TradingView 策略告警',
    '订单动作: {{strategy.order.action}}',
    '订单ID: {{strategy.order.id}}',
    '成交价格: {{strategy.order.price}}',
    '触发原因: {{strategy.order.comment}}',
    '详情: {{strategy.order.alert_message}}',
    '当前仓位: {{strategy.position_size}}',
    '交易品种: {{ticker}}',
  ].join('\n');
}

function inputMap(inputs) {
  if (!inputs) return {};
  if (Array.isArray(inputs)) {
    return Object.fromEntries(inputs.filter((x) => x?.id).map((x) => [x.id, x.value]));
  }
  return { ...inputs };
}

function hasStrategyFeature(inputs) {
  const raw = inputs.pineFeatures ?? inputs.pine_features ?? '';
  if (typeof raw === 'string' && /"strategy"\s*:\s*1|strategy/i.test(raw)) return true;
  return inputs.in_23 === 'order_fills' || inputs.in_71 === 'order_fills';
}

function strategyStudyName(strategy) {
  return strategy.study || strategy.study_name || strategy.studyName || 'StrategyScript@tv-scripting-101';
}

function strategySeries(strategy) {
  const name = String(strategy?.name || '').trim();
  const inputs = inputMap(strategy?.inputs);
  if (!name || !hasStrategyFeature(inputs)) {
    throw new Error('strategy descriptor is required and must include Pine strategy inputs');
  }
  const pineId = strategy.pine_id || strategy.pineId || inputs.pineId || inputs.pine_id;
  const pineVersion = strategy.pine_version || strategy.pineVersion || inputs.pineVersion || inputs.pine_version;
  if (!pineId || !pineVersion) {
    throw new Error('strategy descriptor must include pineId/pineVersion');
  }
  return {
    type: 'study',
    study: strategyStudyName(strategy),
    pine_id: String(pineId),
    pine_version: String(pineVersion),
    inputs,
  };
}

export function buildPriceAlertPayload({
  symbol,
  price,
  condition = 'crossing',
  message = '',
  webhook = null,
  resolution = '1',
  expirationDays = 30,
  name = null,
  notifyOnApp = true,
  sendEmail = false,
  sendPlainText = false,
  showPopup = true,
  playSound = false,
} = {}) {
  const sym = normalizedSymbol(symbol);
  const p = finitePrice(price);
  const condType = normalizeAlertCondition(condition);
  const hook = validateWebhookUrl(webhook);
  const expiration = new Date(Date.now() + Number(expirationDays || 30) * 24 * 3600 * 1000).toISOString();
  return {
    conditions: [{
      type: condType,
      frequency: 'on_first_fire',
      series: [{ type: 'barset' }, { type: 'value', value: p }],
      resolution: String(resolution || '1'),
    }],
    symbol: `=${JSON.stringify({ symbol: sym })}`,
    resolution: String(resolution || '1'),
    message: message ? String(message) : defaultMessage(sym, condType, p),
    sound_file: 'alert/fired',
    sound_duration: playSound ? 1 : 0,
    popup: Boolean(showPopup),
    auto_deactivate: true,
    email: Boolean(sendEmail),
    sms_over_email: Boolean(sendPlainText),
    mobile_push: Boolean(notifyOnApp),
    web_hook: hook,
    name: name ? String(name) : null,
    expiration,
    active: true,
    ignore_warnings: true,
  };
}

export function buildAlertClonePayload(alert, webhook) {
  const conditions = Array.isArray(alert?.conditions)
    ? alert.conditions
    : alert?.condition
      ? [alert.condition]
      : [];
  if (!conditions.length) throw new Error('source alert must include at least one condition');
  const symbol = String(alert?.symbol || '').trim();
  if (!symbol) throw new Error('source alert must include a symbol');
  return {
    conditions: structuredClone(conditions),
    symbol,
    resolution: String(alert.resolution || conditions[0]?.resolution || '1D'),
    message: String(alert.message || ''),
    sound_file: alert.sound_file || 'alert/fired',
    sound_duration: Number(alert.sound_duration || 0),
    popup: Boolean(alert.popup),
    auto_deactivate: Boolean(alert.auto_deactivate),
    email: Boolean(alert.email),
    sms_over_email: Boolean(alert.sms_over_email),
    mobile_push: Boolean(alert.mobile_push),
    web_hook: validateWebhookUrl(webhook),
    name: alert.name ? String(alert.name) : null,
    expiration: alert.expiration ?? null,
    active: true,
    ignore_warnings: true,
  };
}

export function buildAlertModifyPayload(alert, webhook) {
  const alertId = Number(alert?.alert_id);
  if (!Number.isFinite(alertId)) throw new Error('source alert must include a finite alert_id');
  const payload = {
    ...buildAlertClonePayload(alert, webhook),
    alert_id: alertId,
  };
  if (alert.client_id != null) payload.client_id = alert.client_id;
  return payload;
}

export function alertInvariantSnapshot(alert) {
  const conditions = Array.isArray(alert?.conditions)
    ? alert.conditions
    : alert?.condition
      ? [alert.condition]
      : [];
  return {
    alert_id: Number(alert?.alert_id),
    name: alert?.name ?? null,
    symbol: alert?.symbol ?? null,
    resolution: alert?.resolution ?? null,
    message: alert?.message ?? '',
    conditions: structuredClone(conditions),
    sound_file: alert?.sound_file ?? null,
    sound_duration: Number(alert?.sound_duration || 0),
    popup: Boolean(alert?.popup),
    auto_deactivate: Boolean(alert?.auto_deactivate),
    email: Boolean(alert?.email),
    sms_over_email: Boolean(alert?.sms_over_email),
    mobile_push: Boolean(alert?.mobile_push),
    expiration: alert?.expiration ?? null,
  };
}

export function buildStrategyAlertPayload({
  symbol,
  strategy,
  message = '',
  webhook = null,
  resolution = '1D',
  frequency = '60',
  strategyMode = 'strategy',
  name = null,
  notifyOnApp = true,
  sendEmail = false,
  sendPlainText = false,
  showPopup = true,
  playSound = false,
} = {}) {
  const sym = normalizedSymbol(symbol);
  const hook = validateWebhookUrl(webhook);
  const series = strategySeries(strategy);
  return {
    conditions: [{
      type: 'strategy',
      frequency: String(frequency || '60'),
      series: [series],
      strategy_mode: normalizeStrategyAlertMode(strategyMode),
      cross_interval: false,
      resolution: String(resolution || '1D'),
    }],
    symbol: `=${JSON.stringify({ symbol: sym })}`,
    resolution: String(resolution || '1D'),
    message: message ? String(message) : defaultStrategyMessage(),
    sound_file: 'alert/fired',
    sound_duration: playSound ? 1 : 0,
    popup: Boolean(showPopup),
    auto_deactivate: false,
    email: Boolean(sendEmail),
    sms_over_email: Boolean(sendPlainText),
    mobile_push: Boolean(notifyOnApp),
    web_hook: hook,
    name: name ? String(name) : null,
    expiration: null,
    active: true,
    ignore_warnings: true,
  };
}

export function summarizeAlertCondition(condition) {
  if (!condition || typeof condition !== 'object') return condition || null;
  const first = Array.isArray(condition.series) ? condition.series[0] : null;
  if (condition.type === 'strategy') {
    return {
      type: 'strategy',
      frequency: condition.frequency || null,
      study: first?.study || null,
      pine_id: first?.pine_id || first?.inputs?.pineId || null,
      pine_version: first?.pine_version || first?.inputs?.pineVersion || null,
      strategy_mode: condition.strategy_mode || null,
      resolution: condition.resolution || null,
    };
  }
  return {
    type: condition.type || null,
    frequency: condition.frequency || null,
    resolution: condition.resolution || null,
  };
}

export function redactAlertMessage(message, maxLength = 240) {
  if (message == null) return message;
  const masked = String(message)
    .replace(/("secret"\s*:\s*")([^"]+)(")/gi, '$1[redacted]$3')
    .replace(/(secret\s*[=:]\s*)([^,\n}]+)/gi, '$1[redacted]');
  if (masked.length <= maxLength) return masked;
  return `${masked.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function redactWebhookUrl(url) {
  if (!url) return url || null;
  try {
    const parsed = new URL(String(url));
    for (const name of ['token', 'secret', 'key', 'signature']) {
      if (parsed.searchParams.has(name)) parsed.searchParams.set(name, '[redacted]');
    }
    return parsed.toString();
  } catch {
    return '[redacted invalid webhook URL]';
  }
}

export function redactAlertPayloadForDisplay(payload) {
  const copy = JSON.parse(JSON.stringify(payload || {}));
  copy.message = redactAlertMessage(copy.message);
  copy.web_hook = redactWebhookUrl(copy.web_hook);
  for (const condition of copy.conditions || []) {
    for (const series of condition.series || []) {
      if (series.inputs?.text && String(series.inputs.text).length > 80) {
        series.inputs.text = `[redacted ${String(series.inputs.text).length} chars strategy source blob]`;
      }
    }
  }
  return copy;
}
