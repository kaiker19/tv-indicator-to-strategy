#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { disconnect, evaluate } from './connection.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertStep(result, fallback) {
  if (!result?.ok) throw new Error(result?.error || fallback);
  return result;
}

async function waitForDialog(evaluateFn, expression, waitFn, attempts = 8) {
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await evaluateFn(expression);
    if (result?.ok) return result;
    if (result?.error !== 'save_template_dialog_not_found') break;
    await waitFn(250);
  }
  return result;
}

async function waitForTemplateName(evaluateFn, expression, waitFn, name, attempts = 20) {
  let listed;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = await evaluateFn(expression);
    if (candidate?.ok) {
      listed = candidate;
      if (listed.names?.some((value) => value === name || value.includes(name))) return listed;
    } else if (candidate?.error && candidate.error !== 'template_library_not_found') {
      break;
    }
    await waitFn(250);
  }
  return listed;
}

async function waitForTemplateLibrary(listLibraryFn, waitFn, name, attempts = 20) {
  let rows = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    rows = await listLibraryFn();
    if (rows.some((row) => row.name === name)) return rows;
    await waitFn(250);
  }
  return rows;
}

async function confirmReplacement(evaluateFn, waitFn, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = assertStep(await evaluateFn(overwriteExpression), 'template_overwrite_failed');
    if (result.found) {
      if (!result.clicked) throw new Error('template_overwrite_button_not_found');
      return true;
    }
    if (result.pending === false) return false;
    await waitFn(250);
  }
  return false;
}

const openMenuExpression = `
(function() {
  var candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
  var canonical = document.querySelector('#header-toolbar-study-templates button, #header-toolbar-study-templates [role="button"]');
  var button = canonical && canonical.offsetParent !== null ? canonical : candidates.find(function(el) {
    if (el.offsetParent === null) return false;
    var label = el.getAttribute('aria-label') || '';
    var text = (el.textContent || '').trim();
    return label === '指标模板' || label === 'Indicator templates' || text === '指标模板';
  });
  if (!button) return { ok: false, error: 'template_button_not_found' };
  button.click();
  return { ok: true };
})()`;

const clickSaveExpression = `
(function() {
  var candidates = Array.from(document.querySelectorAll('[role="row"], [role="menuitem"], button'));
  var item = candidates.find(function(el) {
    if (el.offsetParent === null) return false;
    var label = el.getAttribute('aria-label') || '';
    var text = (el.textContent || '').trim();
    return /保存指标模板|save indicator template/i.test(label + ' ' + text);
  });
  if (!item) return { ok: false, error: 'save_template_item_not_found' };
  item.click();
  return { ok: true };
})()`;

function fillDialogExpression(name, { saveSymbol, saveInterval }) {
  return `
(function() {
  var name = ${JSON.stringify(name)};
  var saveSymbol = ${JSON.stringify(saveSymbol)};
  var saveInterval = ${JSON.stringify(saveInterval)};
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(function(el) { return el.offsetParent !== null; });
  var dialog = dialogs.find(function(el) {
    return el.getAttribute('data-name') === 'save-rename-dialog'
      || Boolean(el.querySelector('[data-qa-id="ui-lib-Input-input"]'));
  });
  if (!dialog) return { ok: false, error: 'save_template_dialog_not_found' };
  var input = dialog.querySelector('[data-qa-id="ui-lib-Input-input"], input[type="text"], input:not([type])');
  if (!input) return { ok: false, error: 'template_name_input_not_found' };
  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, name);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // Existing names are rendered as autocomplete rows. Selecting the exact
  // row updates TradingView's controlled input state; setting only the DOM
  // property can leave React holding an empty value and silently skip save.
  var exact = Array.from(dialog.querySelectorAll('li, [role="option"], [data-role="list-item"]')).find(function(el) {
    return (el.textContent || '').trim() === name;
  });
  if (exact) exact.click();
  var checks = Array.from(dialog.querySelectorAll('[data-qa-id="ui-lib-checkbox-input-input"], input[type="checkbox"]'));
  var desired = [saveSymbol, saveInterval];
  for (var i = 0; i < Math.min(checks.length, desired.length); i++) {
    if (checks[i].checked !== desired[i]) checks[i].click();
  }
  return { ok: true, checked: checks.slice(0, 2).filter(function(el) { return el.checked; }).length };
})()`;
}

const submitExpression = `
(function() {
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(function(el) { return el.offsetParent !== null; });
  var dialog = dialogs.find(function(el) {
    return el.getAttribute('data-name') === 'save-rename-dialog'
      || Boolean(el.querySelector('[data-qa-id="ui-lib-Input-input"]'));
  });
  if (!dialog) return { ok: false, error: 'save_template_dialog_not_found' };
  var button = dialog.querySelector('button[data-name="submit-button"]');
  if (!button) {
    button = Array.from(dialog.querySelectorAll('button')).find(function(el) {
      return /保存|save/i.test((el.textContent || '').trim());
    });
  }
  if (!button) return { ok: false, error: 'save_template_submit_not_found' };
  button.click();
  return { ok: true };
})()`;

const dismissTemplateUiExpression = `
(function() {
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*=popupDialog]')).filter(function(el) {
    return el.offsetParent !== null;
  });
  var dismissed = [];
  dialogs.slice().reverse().forEach(function(dialog) {
    var input = dialog.querySelector('[data-qa-id="ui-lib-Input-input"]');
    var button = input
      ? Array.from(dialog.querySelectorAll('button, [role="button"]')).find(function(el) {
        return /^(取消|cancel)$/i.test((el.textContent || '').trim());
      })
      : dialog.querySelector('[data-qa-id="close"]');
    if (button) {
      dismissed.push(dialog.getAttribute('data-name') || dialog.getAttribute('role') || 'dialog');
      button.click();
    }
  });
  return { ok: true, dismissed: dismissed };
})()`;

export async function dismissTemplateUi({ evaluateFn = evaluate } = {}) {
  return evaluateFn(dismissTemplateUiExpression);
}

const overwriteExpression = `
(function() {
  var dialogs = Array.from(document.querySelectorAll('[class*=popupDialog], [role="dialog"]')).filter(function(el) {
    return el.offsetParent !== null;
  });
  var dialog = dialogs.find(function(el) {
    return /已经存在.*替换|already exists.*replace/i.test((el.textContent || '').trim());
  });
  if (!dialog) {
    var saveDialog = dialogs.find(function(el) {
      var input = el.querySelector('[data-qa-id="ui-lib-Input-input"], input[type="text"], input:not([type])');
      return Boolean(input) && /保存指标模板|save indicator template/i.test((el.textContent || '').trim());
    });
    return { ok: true, found: false, clicked: false, pending: Boolean(saveDialog) };
  }
  var button = Array.from(dialog.querySelectorAll('button')).find(function(el) {
    return /^(是|替换|yes|replace)$/i.test((el.textContent || '').trim());
  });
  if (!button) return { ok: true, found: true, clicked: false };
  button.click();
  return { ok: true, found: true, clicked: true };
})()`;

const dismissSaveDialogExpression = `
(function() {
  var dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(function(el) {
    return el.offsetParent !== null;
  });
  var dialog = dialogs.find(function(el) {
    var input = el.querySelector('[data-qa-id="ui-lib-Input-input"], input[type="text"], input:not([type])');
    return Boolean(input) && /保存指标模板|save indicator template/i.test((el.textContent || '').trim());
  });
  if (!dialog) return { ok: true, dismissed: false };
  var button = Array.from(dialog.querySelectorAll('button, [role="button"]')).find(function(el) {
    var text = (el.textContent || '').trim();
    var label = (el.getAttribute('aria-label') || '').trim();
    return /^(取消|cancel)$/i.test(text) || /关闭菜单|close menu/i.test(label + ' ' + text);
  });
  if (!button) return { ok: false, error: 'save_template_dismiss_button_not_found' };
  button.click();
  return { ok: true, dismissed: true };
})()`;

const listExpression = `
(function() {
  var dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(function(el) {
    return el.offsetParent !== null && (el.getAttribute('data-name') === 'indicator-templates-dialog'
      || (el.querySelector('[class*="name-"]') && /指标模板|Indicator templates/i.test(el.textContent || '')));
  });
  if (!dialog) return { ok: false, error: 'template_library_not_found', names: [] };
  var named = Array.from(dialog.querySelectorAll('[class*="name-"]')).map(function(el) {
    return (el.textContent || '').trim();
  }).filter(Boolean);
  var legacy = Array.from(dialog.querySelectorAll('[role="row"], [role="menuitem"]')).map(function(el) {
    return (el.getAttribute('aria-label') || el.textContent || '').trim();
  }).filter(Boolean);
  return {
    ok: true,
    names: Array.from(new Set(named.concat(legacy)))
  };
})()`;

const strategyInventoryExpression = `
(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var snapshot = chart.getStudyTemplateSnapshot();
    var indicators = snapshot && snapshot.meta_info && snapshot.meta_info.indicators || [];
    return {
      ok: true,
      strategyNames: indicators
        .filter(function(indicator) { return String(indicator.id || '').indexOf('StrategyScript$') === 0; })
        .map(function(indicator) { return indicator.description || indicator.id; })
    };
  } catch (error) {
    return { ok: false, error: 'strategy_inventory_failed: ' + error.message };
  }
})()`;

const inspectTemplateUiExpression = `
(function() {
  function attrs(el) {
    return {
      tag: el.tagName,
      text: (el.textContent || '').trim().slice(0, 120),
      ariaLabel: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      dataName: el.getAttribute('data-name'),
      qa: el.getAttribute('data-qa-id'),
      className: String(el.className || '').slice(0, 180)
    };
  }
  return Array.from(document.querySelectorAll('[role="dialog"], [class*=popupDialog]'))
    .filter(function(el) { return el.offsetParent !== null; })
    .map(function(dialog) {
      return {
        dialog: attrs(dialog),
        controls: Array.from(dialog.querySelectorAll('button, [role="button"], input')).map(attrs)
      };
    });
})()`;

export async function inspectTemplateUi({ evaluateFn = evaluate } = {}) {
  return evaluateFn(inspectTemplateUiExpression);
}

function deleteTemplateExpression(name) {
  return `
(async function() {
  var name = ${JSON.stringify(name)};
  var endpoint = '/api/v1/study-templates';
  var listed = await fetch(endpoint, { credentials: 'include' });
  if (!listed.ok) return { ok: false, error: 'template_list_http_' + listed.status };
  var body = await listed.json();
  var matches = (body.custom || []).filter(function(row) { return row.name === name; });
  if (matches.length !== 1) {
    return {
      ok: false,
      error: 'template_delete_expected_one_match',
      matches: matches.map(function(row) { return { id: row.id, name: row.name }; })
    };
  }
  var id = matches[0].id;
  var removed = await fetch(endpoint + '/' + encodeURIComponent(id), {
    method: 'DELETE',
    credentials: 'include'
  });
  if (!removed.ok) return { ok: false, error: 'template_delete_http_' + removed.status, id: id };
  var verified = await fetch(endpoint, { credentials: 'include' });
  if (!verified.ok) return { ok: false, error: 'template_verify_http_' + verified.status, id: id };
  var verifyBody = await verified.json();
  var persisted = (verifyBody.custom || []).some(function(row) { return row.id === id || row.name === name; });
  return { ok: !persisted, id: id, name: name, persisted: persisted };
})()`;
}

export async function deleteStudyTemplate(name, { evaluateFn = evaluate } = {}) {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) throw new Error('template_name_required');
  const result = await evaluateFn(deleteTemplateExpression(normalizedName), { awaitPromise: true });
  if (!result?.ok) throw new Error(result?.error || `template_delete_failed: ${normalizedName}`);
  return { success: true, name: normalizedName, id: result.id };
}

function readTemplateExpression(name) {
  return `
(async function() {
  var name = ${JSON.stringify(name)};
  var endpoint = '/api/v1/study-templates';
  var listed = await fetch(endpoint, { credentials: 'include' });
  if (!listed.ok) return { ok: false, error: 'template_list_http_' + listed.status };
  var body = await listed.json();
  var matches = (body.custom || []).filter(function(row) { return row.name === name; });
  if (matches.length !== 1) return { ok: false, error: 'template_read_expected_one_match' };
  var id = matches[0].id;
  var detail = await fetch(endpoint + '/' + id, { credentials: 'include' });
  if (!detail.ok) return { ok: false, error: 'template_read_http_' + detail.status };
  return { ok: true, record: await detail.json() };
})()`;
}

export async function readStudyTemplate(name, { evaluateFn = evaluate } = {}) {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) throw new Error('template_name_required');
  const result = await evaluateFn(readTemplateExpression(normalizedName), { awaitPromise: true });
  if (!result?.ok || !result.record) throw new Error(result?.error || `template_read_failed: ${normalizedName}`);
  return result.record;
}

function updateTemplateExpression(name, payload) {
  return `
(async function() {
  var name = ${JSON.stringify(name)};
  var payload = ${JSON.stringify(payload)};
  var endpoint = '/api/v1/study-templates';
  var listed = await fetch(endpoint, { credentials: 'include' });
  if (!listed.ok) return { ok: false, error: 'template_list_http_' + listed.status };
  var body = await listed.json();
  var matches = (body.custom || []).filter(function(row) { return row.name === name; });
  if (matches.length !== 1) return { ok: false, error: 'template_update_expected_one_match' };
  var id = matches[0].id;
  var updated = await fetch(endpoint + '/' + id, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: name, content: payload.content, meta_info: payload.meta_info })
  });
  if (!updated.ok) return { ok: false, error: 'template_update_http_' + updated.status };
  var verified = await fetch(endpoint + '/' + id, { credentials: 'include' });
  if (!verified.ok) return { ok: false, error: 'template_verify_http_' + verified.status };
  var record = await verified.json();
  var matchesPayload = record.name === name &&
    record.content === payload.content &&
    JSON.stringify(record.meta_info) === JSON.stringify(payload.meta_info);
  if (!matchesPayload) return { ok: false, error: 'template_update_payload_mismatch', id: id };
  return { ok: true, id: id, name: name };
})()`;
}

export async function updateStudyTemplate(name, payload, { evaluateFn = evaluate } = {}) {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) throw new Error('template_name_required');
  if (typeof payload?.content !== 'string' || !payload?.meta_info) {
    throw new Error('template_update_payload_required');
  }
  const result = await evaluateFn(updateTemplateExpression(normalizedName, payload), { awaitPromise: true });
  if (!result?.ok) throw new Error(result?.error || `template_update_failed: ${normalizedName}`);
  return { success: true, id: result.id, name: normalizedName };
}

export async function saveStudyTemplate(name, {
  evaluateFn = evaluate,
  waitFn = sleep,
  saveSymbol = true,
  saveInterval = true,
  expectedStrategyName = null,
  replaceExisting = false,
  listLibraryFn = null,
  dismissUiFn = null,
} = {}) {
  if (!String(name || '').trim()) throw new Error('template_name_required');
  const normalizedName = String(name).trim();

  if (expectedStrategyName) {
    const inventory = assertStep(
      await evaluateFn(strategyInventoryExpression),
      'strategy_inventory_failed',
    );
    const strategyNames = inventory.strategyNames || [];
    if (strategyNames.length !== 1 || strategyNames[0] !== expectedStrategyName) {
      throw new Error(
        `unexpected_strategy_set: expected ${expectedStrategyName}, got ${strategyNames.join(' | ') || '(none)'}`,
      );
    }
  }

  assertStep(await evaluateFn(openMenuExpression), 'template_menu_open_failed');
  await waitFn(250);
  assertStep(await evaluateFn(clickSaveExpression), 'save_template_item_click_failed');
  await waitFn(250);
  assertStep(
    await waitForDialog(
      evaluateFn,
      fillDialogExpression(normalizedName, { saveSymbol, saveInterval }),
      waitFn,
    ),
    'save_template_dialog_fill_failed',
  );
  await waitFn(250);
  assertStep(await evaluateFn(submitExpression), 'save_template_submit_failed');
  if (replaceExisting) {
    await confirmReplacement(evaluateFn, waitFn);
  }
  await waitFn(250);
  assertStep(await evaluateFn(dismissSaveDialogExpression), 'save_template_dialog_dismiss_failed');
  await waitFn(800);

  if (listLibraryFn) {
    const rows = await waitForTemplateLibrary(listLibraryFn, waitFn, normalizedName);
    if (!rows.some((row) => row.name === normalizedName)) {
      throw new Error(`template_not_visible_after_save: ${normalizedName}`);
    }
    if (dismissUiFn) await dismissUiFn();
  } else {
    assertStep(await evaluateFn(openMenuExpression), 'template_menu_reopen_failed');
    await waitFn(250);
    const listed = await waitForTemplateName(evaluateFn, listExpression, waitFn, normalizedName);
    if (!listed?.names?.some((candidate) => candidate === normalizedName || candidate.includes(normalizedName))) {
      throw new Error(`template_not_visible_after_save: ${normalizedName}`);
    }
    assertStep(await evaluateFn(openMenuExpression), 'template_menu_close_failed');
  }

  return { success: true, name: normalizedName, saveSymbol, saveInterval };
}

async function main(argv) {
  const [command, name, ...flags] = argv;
  if (command === 'inspect') return inspectTemplateUi();
  if (command === 'dismiss') return dismissTemplateUi();
  if (command !== 'save' || !name) {
    throw new Error('usage: node study_templates.mjs inspect | dismiss | save <name> [--replace] [--no-symbol] [--no-interval] [--expect-strategy <name>]');
  }
  const expectedStrategyIndex = flags.indexOf('--expect-strategy');
  const expectedStrategyName = expectedStrategyIndex >= 0 ? flags[expectedStrategyIndex + 1] : null;
  if (expectedStrategyIndex >= 0 && !expectedStrategyName) throw new Error('expect_strategy_name_required');
  return saveStudyTemplate(name, {
    saveSymbol: !flags.includes('--no-symbol'),
    saveInterval: !flags.includes('--no-interval'),
    expectedStrategyName,
    replaceExisting: flags.includes('--replace'),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await disconnect();
  }
}
