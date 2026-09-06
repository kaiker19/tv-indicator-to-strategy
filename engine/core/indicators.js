/**
 * Core indicator settings logic.
 */
import { evaluate, safeString } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function setInputs({ entity_id, inputs: inputsRaw, timeoutMs = 20_000, _deps = {} }) {
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (!inputs || typeof inputs !== 'object' || Object.keys(inputs).length === 0) {
    throw new Error('inputs must be a non-empty object, e.g. { length: 50 }');
  }

  const inputsJson = JSON.stringify(inputs);

  const run = _deps.evaluate || evaluate;
  const timeout = Math.max(1, Math.min(60_000, Number(timeoutMs) || 20_000));
  const result = await run(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var currentInputs = study.getInputValues();
      var overrides = ${inputsJson};
      var updatedKeys = {};
      if (!currentInputs.length) {
        return { error: 'INPUT_UPDATE_REQUIRES_REINJECT: runtime input values unavailable for this strategy' };
      }
      var keys = Object.keys(overrides);
      var invalid = keys.filter(function(key) {
        return !/^in_\\d+$/.test(key) || !currentInputs.some(function(input) { return input.id === key; });
      });
      if (invalid.length) return { error: 'INPUT_UPDATE_MISMATCH: ' + invalid.join(',') };
      var changed = keys.filter(function(key) {
        return JSON.stringify(currentInputs.find(function(input) { return input.id === key; }).value) !== JSON.stringify(overrides[key]);
      }).map(function(key) { return { id: key, value: overrides[key] }; });
      function readInputs() {
        var state = study.getInputValues();
        var verified = {};
        for (var key of keys) {
          var input = state.find(function(item) { return item.id === key; });
          if (!input || JSON.stringify(input.value) !== JSON.stringify(overrides[key])) return null;
          verified[key] = input.value;
        }
        return verified;
      }
      function readReport() {
        var source = study.study();
        var report = typeof source.reportData === 'function' ? source.reportData() : source.reportData;
        return report && typeof report.value === 'function' ? report.value() : report;
      }
      if (!changed.length && !study.isLoading()) return {
        updated_inputs: overrides, verified_inputs: readInputs(), input_source: 'study_api_unchanged', recalculated: false
      };
      var before = readReport();
      var loaded = study.onDataLoaded();
      return new Promise(function(resolve) {
        var completed = false, settled = false, timer;
        function finish(result) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          loaded.unsubscribe(null, onLoaded);
          resolve(result);
        }
        function onLoaded() { completed = true; }
        function check() {
          if (settled) return;
          var verified = readInputs();
          var report = readReport();
          if (completed && !study.isLoading() && verified && (!before || (report && report !== before))) {
            finish({ updated_inputs: overrides, verified_inputs: verified, input_source: 'study_api', recalculated: true });
          } else setTimeout(check, 100);
        }
        loaded.subscribe(null, onLoaded);
        timer = setTimeout(function() {
          finish({ error: 'INPUT_UPDATE_REQUIRES_REINJECT: new inputs did not produce a verified completed report' });
        }, ${timeout});
        try {
          // Never round-trip text/pineId/pineVersion: those are compiled-script
          // identity fields, not user overrides, and can invalidate the study.
          study.setInputValues(changed);
          check();
        } catch (error) { finish({ error: 'INPUT_UPDATE_REQUIRES_REINJECT: ' + error.message }); }
      });
    })()
  `, { awaitPromise: true });

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, updated_inputs: result.updated_inputs,
    verified_inputs: result.verified_inputs, input_source: result.input_source, recalculated: result.recalculated };
}

export async function toggleVisibility({ entity_id, visible }) {
  if (!entity_id) throw new Error('entity_id is required. Use chart_get_state to find study IDs.');
  if (typeof visible !== 'boolean') throw new Error('visible must be a boolean (true or false)');

  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var study = chart.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      study.setVisible(${visible});
      var actualVisible = study.isVisible();
      return { visible: actualVisible };
    })()
  `);

  if (result && result.error) throw new Error(result.error);
  return { success: true, entity_id, visible: result.visible };
}
