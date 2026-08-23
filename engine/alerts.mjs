#!/usr/bin/env node
import { pathToFileURL } from 'url';
import {
  alertInvariantSnapshot,
  buildAlertClonePayload,
  buildAlertModifyPayload,
  buildPriceAlertPayload,
  buildStrategyAlertPayload,
  normalizeAlertCondition,
  redactAlertMessage,
  redactAlertPayloadForDisplay,
  redactWebhookUrl,
  summarizeAlertCondition,
} from './alert_payload.mjs';
import { disconnect, evaluate, evaluateAsync } from './connection.js';

const PRICE_ALERTS = {
  list: 'https://pricealerts.tradingview.com/list_alerts',
  create: 'https://pricealerts.tradingview.com/create_alert',
  modify: 'https://pricealerts.tradingview.com/modify_restart_alert',
  delete: 'https://pricealerts.tradingview.com/delete_alerts',
};

function usage() {
  return [
    'Usage:',
    '  node alerts.mjs probe',
    '  node alerts.mjs list',
    '  node alerts.mjs create --price <number> [--condition crossing|greater_than|less_than] [--message <text>] [--name <text>] [notification flags] [--webhook <url>] [--symbol <TV_SYMBOL>] [--commit]',
    '  node alerts.mjs strategy-probe [--study-name <strategy name>]',
    '  node alerts.mjs strategy-create [--study-name <strategy name> | --study-id <entity id>] [--pine-id <saved Pine id>] [--pine-version <version>] [--strategy-mode strategy|alerts|strategy_and_alerts] [--message <text>] [--name <text>] [notification flags] [--webhook <url>] [--commit]',
    '  node alerts.mjs modify-webhook --id <alert_id> --webhook <url> [--commit]',
    '  node alerts.mjs delete --id <alert_id> [--commit]',
    '  node alerts.mjs delete --all [--commit]',
    '',
    'Notification flags: --notify-app/--no-notify-app --send-email --send-plain-text --show-popup/--no-popup --play-sound/--no-sound.',
    'Create/modify/delete are dry-run by default. Add --commit to write to TradingView.',
  ].join('\n');
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseAlertIds(raw) {
  return String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const n = Number(x);
      return Number.isFinite(n) ? n : x;
    });
}

export function parseArgs(argv) {
  const args = { command: 'probe', commit: false, all: false, ids: [] };
  let i = 0;
  if (argv[0] && !argv[0].startsWith('--')) {
    args.command = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--commit':
        args.commit = true;
        break;
      case '--all':
        args.all = true;
        break;
      case '--json':
        break;
      case '--price':
        args.price = takeValue(argv, i, token);
        i++;
        break;
      case '--condition':
        args.condition = takeValue(argv, i, token);
        i++;
        break;
      case '--message':
        args.message = takeValue(argv, i, token);
        i++;
        break;
      case '--name':
        args.name = takeValue(argv, i, token);
        i++;
        break;
      case '--notify-app':
        args.notifyOnApp = true;
        break;
      case '--no-notify-app':
        args.notifyOnApp = false;
        break;
      case '--send-email':
        args.sendEmail = true;
        break;
      case '--no-email':
        args.sendEmail = false;
        break;
      case '--send-plain-text':
        args.sendPlainText = true;
        break;
      case '--no-plain-text':
        args.sendPlainText = false;
        break;
      case '--show-popup':
        args.showPopup = true;
        break;
      case '--no-popup':
        args.showPopup = false;
        break;
      case '--play-sound':
        args.playSound = true;
        break;
      case '--no-sound':
        args.playSound = false;
        break;
      case '--webhook':
        args.webhook = takeValue(argv, i, token);
        i++;
        break;
      case '--symbol':
        args.symbol = takeValue(argv, i, token);
        i++;
        break;
      case '--resolution':
        args.resolution = takeValue(argv, i, token);
        i++;
        break;
      case '--study-name':
        args.studyName = takeValue(argv, i, token);
        i++;
        break;
      case '--study-id':
        args.studyId = takeValue(argv, i, token);
        i++;
        break;
      case '--pine-id':
        args.pineId = takeValue(argv, i, token);
        i++;
        break;
      case '--pine-version':
        args.pineVersion = takeValue(argv, i, token);
        i++;
        break;
      case '--strategy-mode':
        args.strategyMode = takeValue(argv, i, token);
        i++;
        break;
      case '--limit': {
        const limit = Number(takeValue(argv, i, token));
        if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
        args.limit = limit;
        i++;
        break;
      }
      case '--expiration-days':
        args.expirationDays = takeValue(argv, i, token);
        i++;
        break;
      case '--id':
      case '--alert-id':
        args.ids.push(...parseAlertIds(takeValue(argv, i, token)));
        i++;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function output(result) {
  console.log(JSON.stringify(result, null, 2));
}

function requirePrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) throw new Error('--price must be a finite number');
  return n;
}

function uniqueIds(ids) {
  return [...new Set((ids || []).filter((x) => x !== null && x !== undefined && x !== ''))];
}

async function readChartSymbol() {
  return evaluate(`
    (function() {
      try {
        var api = window.TradingViewApi;
        var chart = api && api._activeChartWidgetWV && api._activeChartWidgetWV.value && api._activeChartWidgetWV.value();
        var model = chart && chart._chartWidget && chart._chartWidget.model && chart._chartWidget.model();
        var series = model && model.mainSeries && model.mainSeries();
        var sym = null;
        if (series) {
          if (typeof series.proSymbol === 'function') sym = series.proSymbol();
          if (!sym && typeof series.symbol === 'function') sym = series.symbol();
          if (!sym && series._symbolInfo) sym = series._symbolInfo.full_name || series._symbolInfo.pro_name || series._symbolInfo.name || series._symbolInfo.ticker;
        }
        if (sym && typeof sym === 'object') sym = sym.full_name || sym.pro_name || sym.name || sym.ticker || null;
        return sym ? String(sym) : null;
      } catch (e) {
        return null;
      }
    })()
  `);
}

async function probeAlertCapability() {
  const probe = await evaluate(`
    (function() {
      function has(sel) { return !!document.querySelector(sel); }
      var symbol = null;
      var chartReady = false;
      var alertServiceAvailable = false;
      try {
        var api = window.TradingViewApi;
        alertServiceAvailable = !!(api && api._alertService);
        var chart = api && api._activeChartWidgetWV && api._activeChartWidgetWV.value && api._activeChartWidgetWV.value();
        chartReady = !!chart;
        var model = chart && chart._chartWidget && chart._chartWidget.model && chart._chartWidget.model();
        var series = model && model.mainSeries && model.mainSeries();
        if (series) {
          if (typeof series.proSymbol === 'function') symbol = series.proSymbol();
          if (!symbol && typeof series.symbol === 'function') symbol = series.symbol();
        }
      } catch (e) {}
      return {
        chart_ready: chartReady,
        chart_symbol: symbol ? String(symbol) : null,
        alert_service_available: alertServiceAvailable,
        alerts_panel_button: has('[data-name="alerts-button"]') || has('[data-name="alerts"]') || has('[aria-label="Alerts"]'),
        create_alert_button: has('[aria-label="Create Alert"]') || has('[data-name="set-alert-button"]'),
        alert_dialog_open: has('[data-qa-id="alerts-create-edit-dialog"]') || has('[data-name="alert-dialog"]') || has('[class*="alert-dialog"]'),
        alert_message_editor_open: has('[data-qa-id="alerts-message-edit-dialog"]'),
        alert_notifications_editor_open: has('[data-qa-id="alerts-notifications-edit-dialog"]'),
      };
    })()
  `);
  return {
    success: true,
    source: 'cdp_dom_probe',
    ...probe,
    pricealerts_api: PRICE_ALERTS,
    writes_require_commit: true,
  };
}

function parseAlertSymbol(symbol) {
  if (!symbol) return null;
  try {
    const parsed = JSON.parse(String(symbol).replace(/^=/, ''));
    return parsed.symbol || String(symbol);
  } catch {
    return String(symbol);
  }
}

function normalizeAlertRecord(alert) {
  const firstCondition = Array.isArray(alert.conditions) ? alert.conditions[0] : null;
  return {
    alert_id: alert.alert_id,
    name: alert.name || null,
    symbol: parseAlertSymbol(alert.symbol),
    active: alert.active,
    message: redactAlertMessage(alert.message),
    condition: summarizeAlertCondition(alert.condition || firstCondition),
    resolution: alert.resolution,
    created: alert.create_time,
    last_fired: alert.last_fire_time,
    expiration: alert.expiration,
    last_error: alert.last_error || alert.last_error_message || null,
    notifications: {
      app: Boolean(alert.mobile_push),
      primary_email: Boolean(alert.email),
      alternative_email: Boolean(alert.sms_over_email),
      popup: Boolean(alert.popup),
      sound: Number(alert.sound_duration || 0) > 0,
    },
    web_hook: redactWebhookUrl(alert.web_hook),
    web_hook_configured: Boolean(alert.web_hook),
  };
}

export async function listAlerts({ limit } = {}) {
  const result = await evaluateAsync(`
    fetch('${PRICE_ALERTS.list}', { credentials: 'include' })
      .then(function(r) {
        return r.text().then(function(text) {
          var data = {};
          try { data = JSON.parse(text); } catch (e) {
            return { ok: false, status: r.status, error: 'Invalid JSON response', response: text.slice(0, 300) };
          }
          if (!r.ok || data.s !== 'ok' || !Array.isArray(data.r)) {
            return { ok: false, status: r.status, error: data.errmsg || (data.err && data.err.code) || 'Unexpected response', response: text.slice(0, 300) };
          }
          return { ok: true, status: r.status, alerts: data.r };
        });
      })
      .catch(function(e) { return { ok: false, error: e.message }; })
  `);
  if (!result?.ok) {
    return {
      success: false,
      source: 'pricealerts_api',
      alert_count: 0,
      alerts: [],
      error: result?.error || 'list_alerts failed',
      status: result?.status,
      response: result?.response,
    };
  }
  const alerts = (result.alerts || []).slice(0, limit || result.alerts.length).map(normalizeAlertRecord);
  return { success: true, source: 'pricealerts_api', alert_count: alerts.length, alerts };
}

function summarizeStrategyDescriptor(strategy) {
  const inputs = strategy?.inputs || {};
  return {
    id: strategy?.id || null,
    name: strategy?.name || null,
    study: strategy?.study || null,
    pine_id: strategy?.pine_id || inputs.pineId || null,
    pine_version: strategy?.pine_version || inputs.pineVersion || null,
    input_count: Object.keys(inputs).length,
    signal_mode: inputs.in_23 || inputs.in_71 || null,
  };
}

async function readChartContext() {
  return evaluate(`
    (function() {
      function inputMap(items) {
        var out = {};
        if (Array.isArray(items)) {
          items.forEach(function(x) { if (x && x.id) out[x.id] = x.value; });
        }
        return out;
      }
      function isStrategy(inputs) {
        var raw = inputs.pineFeatures || inputs.pine_features || '';
        return /"strategy"\\s*:\\s*1|strategy/i.test(String(raw)) || inputs.in_23 === 'order_fills' || inputs.in_71 === 'order_fills';
      }
      function chartSymbol(chart) {
        try { if (typeof chart.symbol === 'function') return chart.symbol(); } catch(e) {}
        try {
          var model = chart && chart._chartWidget && chart._chartWidget.model && chart._chartWidget.model();
          var series = model && model.mainSeries && model.mainSeries();
          var sym = series && series.proSymbol && series.proSymbol();
          return sym ? String(sym) : null;
        } catch(e) { return null; }
      }
      function chartResolution(chart) {
        try { if (typeof chart.resolution === 'function') return chart.resolution(); } catch(e) {}
        return null;
      }
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies() || [];
      var strategies = [];
      for (var i = 0; i < studies.length; i++) {
        var st = studies[i];
        try {
          var handle = chart.getStudyById(st.id);
          var inputs = inputMap(handle && handle.getInputValues && handle.getInputValues());
          if (!isStrategy(inputs)) continue;
          strategies.push({
            id: st.id,
            name: st.name || st.title || 'unknown',
            study: 'StrategyScript@tv-scripting-101',
            inputs: inputs,
            pine_id: inputs.pineId || inputs.pine_id || null,
            pine_version: inputs.pineVersion || inputs.pine_version || null
          });
        } catch (e) {
          strategies.push({ id: st.id, name: st.name || 'unknown', error: e.message });
        }
      }
      return {
        symbol: chartSymbol(chart),
        resolution: chartResolution(chart),
        strategy_count: strategies.length,
        strategies: strategies
      };
    })()
  `);
}

function selectStrategy(context, studyName, studyId = null) {
  const strategies = context?.strategies || [];
  if (studyId) {
    const exactId = strategies.find((s) => s.id === studyId);
    if (exactId) return exactId;
    throw new Error(`strategy study id not found: ${studyId}`);
  }
  if (studyName) {
    const exact = strategies.find((s) => s.name === studyName);
    if (exact) return exact;
    const loose = strategies.find((s) => String(s.name || '').toLowerCase().includes(String(studyName).toLowerCase()));
    if (loose) return loose;
    throw new Error(`strategy study not found: ${studyName}`);
  }
  if (strategies.length === 1) return strategies[0];
  if (strategies.length === 0) throw new Error('No strategy study found on the current chart.');
  throw new Error(`Multiple strategy studies found (${strategies.map((s) => s.name).join(', ')}). Pass --study-name.`);
}

export function overrideStrategyIdentity(strategy, pineId, pineVersion = null) {
  if (!pineId) return strategy;
  const version = pineVersion || strategy?.pine_version || strategy?.pineVersion
    || strategy?.inputs?.pineVersion || strategy?.inputs?.pine_version;
  return {
    ...strategy,
    pine_id: pineId,
    pine_version: version,
    inputs: {
      ...(strategy?.inputs || {}),
      pineId,
      pineVersion: version,
    },
  };
}

export async function strategyProbe(args) {
  const context = await readChartContext();
  let selected = null;
  if (args.studyName || args.studyId || context.strategy_count === 1) {
    selected = summarizeStrategyDescriptor(selectStrategy(context, args.studyName, args.studyId));
  }
  return {
    success: true,
    source: 'chart_strategy_probe',
    symbol: context.symbol,
    resolution: context.resolution,
    strategy_count: context.strategy_count,
    selected,
    strategies: (context.strategies || []).map(summarizeStrategyDescriptor),
    writes_require_commit: true,
  };
}

async function postCreatePayload(payload) {
  return evaluate(`
    (function() {
      try {
        var payload = ${JSON.stringify(payload)};
        var x = new XMLHttpRequest();
        x.open('POST', '${PRICE_ALERTS.create}', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: payload }));
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') {
          return { success: true, status: x.status, alert_id: data.r && data.r.alert_id || null };
        }
        return {
          success: false,
          status: x.status,
          error: data.errmsg || data.err?.code || ('HTTP ' + x.status),
          error_code: data.err?.code || null,
          response: (x.responseText || '').slice(0, 300)
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    })()
  `);
}

async function readRawAlert(alertId) {
  const numericId = Number(alertId);
  if (!Number.isFinite(numericId)) throw new Error('alertId must be a finite number');
  const listed = await evaluateAsync(`
    fetch('${PRICE_ALERTS.list}', { credentials: 'include' })
      .then(function(r) {
        return r.text().then(function(text) {
          var data = {};
          try { data = JSON.parse(text); } catch (e) {
            return { ok: false, status: r.status, error: 'Invalid JSON response' };
          }
          if (!r.ok || data.s !== 'ok' || !Array.isArray(data.r)) {
            return { ok: false, status: r.status, error: data.errmsg || 'Unexpected response' };
          }
          var alert = data.r.find(function(row) { return Number(row.alert_id) === ${numericId}; });
          return alert ? { ok: true, alert: alert } : { ok: false, status: 404, error: 'source_alert_not_found' };
        });
      })
      .catch(function(e) { return { ok: false, error: e.message }; })
  `);
  if (!listed?.ok) throw new Error(listed?.error || 'source_alert_lookup_failed');
  return listed.alert;
}

async function postModifyPayload(payload) {
  return evaluate(`
    (function() {
      try {
        var payload = ${JSON.stringify(payload)};
        var x = new XMLHttpRequest();
        x.open('POST', '${PRICE_ALERTS.modify}', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: payload }));
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') {
          return { success: true, status: x.status, alert_id: data.r && data.r.alert_id || payload.alert_id };
        }
        return {
          success: false,
          status: x.status,
          error: data.errmsg || data.err?.code || ('HTTP ' + x.status),
          error_code: data.err?.code || null,
          response: (x.responseText || '').slice(0, 300)
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    })()
  `);
}

export async function modifyAlertWebhookInPlace({ alertId, webhook, commit = false }) {
  const source = await readRawAlert(alertId);
  if (source.active !== true) throw new Error('source alert must be active');
  const payload = buildAlertModifyPayload(source, webhook);
  const invariant = alertInvariantSnapshot(source);
  if (!commit) {
    return {
      success: true,
      dry_run: true,
      action: 'modify_webhook_in_place',
      alert_id: payload.alert_id,
      payload: redactAlertPayloadForDisplay(payload),
    };
  }

  const result = await postModifyPayload(payload);
  if (!result?.success) return { ...result, dry_run: false, action: 'modify_webhook_in_place' };

  const updated = await readRawAlert(payload.alert_id);
  if (JSON.stringify(alertInvariantSnapshot(updated)) !== JSON.stringify(invariant)) {
    throw new Error(`alert_invariant_changed_after_modify: ${payload.alert_id}`);
  }
  if (!updated.web_hook) throw new Error(`webhook_missing_after_modify: ${payload.alert_id}`);
  if (updated.active !== true || updated.last_error) {
    throw new Error(`alert_unhealthy_after_modify: ${payload.alert_id}`);
  }
  return {
    ...result,
    dry_run: false,
    action: 'modify_webhook_in_place',
    alert_id: payload.alert_id,
    name: payload.name,
    webhook: redactWebhookUrl(updated.web_hook),
    invariant_preserved: true,
  };
}

export async function cloneAlertWithWebhook({ alertId, webhook, commit = false }) {
  const numericId = Number(alertId);
  if (!Number.isFinite(numericId)) throw new Error('alertId must be a finite number');
  const listed = await evaluateAsync(`
    fetch('${PRICE_ALERTS.list}', { credentials: 'include' })
      .then(function(r) {
        return r.text().then(function(text) {
          var data = {};
          try { data = JSON.parse(text); } catch (e) {
            return { ok: false, status: r.status, error: 'Invalid JSON response' };
          }
          if (!r.ok || data.s !== 'ok' || !Array.isArray(data.r)) {
            return { ok: false, status: r.status, error: data.errmsg || 'Unexpected response' };
          }
          var alert = data.r.find(function(row) { return Number(row.alert_id) === ${numericId}; });
          return alert ? { ok: true, alert: alert } : { ok: false, status: 404, error: 'source_alert_not_found' };
        });
      })
      .catch(function(e) { return { ok: false, error: e.message }; })
  `);
  if (!listed?.ok) throw new Error(listed?.error || 'source_alert_lookup_failed');
  const payload = buildAlertClonePayload(listed.alert, webhook);
  if (!commit) {
    return {
      success: true,
      dry_run: true,
      action: 'clone_with_webhook',
      source_alert_id: numericId,
      payload: redactAlertPayloadForDisplay(payload),
    };
  }
  const result = await postCreatePayload(payload);
  return {
    ...result,
    dry_run: false,
    action: 'clone_with_webhook',
    source_alert_id: numericId,
    webhook: redactWebhookUrl(payload.web_hook),
    name: payload.name,
  };
}

async function createAlert(args) {
  const symbol = String(args.symbol || await readChartSymbol() || '').trim();
  if (!symbol) throw new Error('Could not read chart symbol. Pass --symbol or open a TradingView chart.');
  const payload = buildPriceAlertPayload({
    symbol,
    price: requirePrice(args.price),
    condition: normalizeAlertCondition(args.condition || 'crossing'),
    message: args.message || '',
    webhook: args.webhook || null,
    resolution: args.resolution || '1',
    expirationDays: args.expirationDays || 30,
    name: args.name || null,
    notifyOnApp: args.notifyOnApp,
    sendEmail: args.sendEmail,
    sendPlainText: args.sendPlainText,
    showPopup: args.showPopup,
    playSound: args.playSound,
  });

  if (!args.commit) {
    return {
      success: true,
      dry_run: true,
      action: 'create',
      source: 'pricealerts_api',
      note: 'Add --commit to create this alert in TradingView.',
      payload: redactAlertPayloadForDisplay(payload),
    };
  }

  const result = await postCreatePayload(payload);

  return {
    ...result,
    dry_run: false,
    action: 'create',
    source: 'pricealerts_api',
    symbol,
    price: Number(args.price),
    condition: normalizeAlertCondition(args.condition || 'crossing'),
    message: redactAlertMessage(payload.message),
    webhook: redactWebhookUrl(payload.web_hook),
  };
}

export async function createStrategyAlert(args) {
  const context = await readChartContext();
  const chartStrategy = selectStrategy(context, args.studyName, args.studyId);
  const strategy = overrideStrategyIdentity(chartStrategy, args.pineId, args.pineVersion);
  const payload = buildStrategyAlertPayload({
    symbol: args.symbol || context.symbol,
    strategy,
    message: args.message || '',
    webhook: args.webhook || null,
    resolution: args.resolution || context.resolution || '1D',
    strategyMode: args.strategyMode || 'strategy',
    name: args.name || null,
    notifyOnApp: args.notifyOnApp,
    sendEmail: args.sendEmail,
    sendPlainText: args.sendPlainText,
    showPopup: args.showPopup,
    playSound: args.playSound,
  });

  if (!args.commit) {
    return {
      success: true,
      dry_run: true,
      action: 'strategy-create',
      source: 'pricealerts_api',
      note: 'Add --commit to create this strategy alert in TradingView.',
      strategy: summarizeStrategyDescriptor(strategy),
      payload: redactAlertPayloadForDisplay(payload),
    };
  }

  const result = await postCreatePayload(payload);
  return {
    ...result,
    dry_run: false,
    action: 'strategy-create',
    source: 'pricealerts_api',
    symbol: args.symbol || context.symbol,
    resolution: payload.resolution,
    strategy: summarizeStrategyDescriptor(strategy),
    message: redactAlertMessage(payload.message),
    webhook: redactWebhookUrl(payload.web_hook),
  };
}

export async function deleteAlerts(args) {
  let ids = uniqueIds(args.ids);
  if (!args.all && !ids.length) throw new Error('delete requires --id <alert_id> or --all');

  if (!args.commit) {
    return {
      success: true,
      dry_run: true,
      action: 'delete',
      source: 'pricealerts_api',
      delete_all: !!args.all,
      alert_ids: ids,
      note: 'Add --commit to delete alerts in TradingView.',
    };
  }

  if (args.all) {
    const listed = await listAlerts();
    if (!listed.success) return listed;
    ids = uniqueIds(listed.alerts.map((a) => a.alert_id));
  }
  if (!ids.length) {
    return { success: false, dry_run: false, action: 'delete', source: 'pricealerts_api', error: 'No alerts to delete.' };
  }

  const result = await evaluate(`
    (function() {
      try {
        var x = new XMLHttpRequest();
        x.open('POST', '${PRICE_ALERTS.delete}', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } }));
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') return { success: true, status: x.status };
        return { success: false, status: x.status, error: data.errmsg || (data.err && data.err.code) || ('HTTP ' + x.status), response: (x.responseText || '').slice(0, 300) };
      } catch (e) {
        return { success: false, error: e.message };
      }
    })()
  `);

  return {
    ...result,
    dry_run: false,
    action: 'delete',
    source: 'pricealerts_api',
    delete_all: !!args.all,
    deleted_count: result?.success ? ids.length : 0,
    alert_ids: ids,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  switch (args.command) {
    case 'probe':
      output(await probeAlertCapability());
      break;
    case 'list':
      output(await listAlerts(args));
      break;
    case 'create':
      output(await createAlert(args));
      break;
    case 'strategy-probe':
      output(await strategyProbe(args));
      break;
    case 'strategy-create':
      output(await createStrategyAlert(args));
      break;
    case 'modify-webhook':
      if (args.ids.length !== 1) throw new Error('modify-webhook requires exactly one --id');
      if (!args.webhook) throw new Error('modify-webhook requires --webhook');
      output(await modifyAlertWebhookInPlace({ alertId: args.ids[0], webhook: args.webhook, commit: args.commit }));
      break;
    case 'delete':
      output(await deleteAlerts(args));
      break;
    default:
      throw new Error(`Unknown command: ${args.command}\n${usage()}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    output({ success: false, error: err.message });
    process.exitCode = 1;
  }).finally(async () => {
    await disconnect();
  });
}
