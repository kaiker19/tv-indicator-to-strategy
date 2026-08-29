/**
 * Core chart control logic.
 */
import { evaluate as _evaluate, evaluateAsync as _evaluateAsync, safeString, requireFinite } from '../connection.js';
import { waitForChartReady as _waitForChartReady } from '../wait.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    waitForChartReady: deps?.waitForChartReady || _waitForChartReady,
  };
}

function ticker(value) {
  return String(value || '').trim().toUpperCase().split(':').at(-1);
}

async function readSeriesSnapshot(evaluate = _evaluate) {
  return evaluate(`
    (function() {
      try {
        var chart = ${CHART_API};
        var series = chart._chartWidget.model().mainSeries();
        var bars = series.bars();
        if (!bars || typeof bars.firstIndex !== 'function' || typeof bars.lastIndex !== 'function') return null;
        var firstIndex = bars.firstIndex();
        var lastIndex = bars.lastIndex();
        if (!Number.isFinite(firstIndex) || !Number.isFinite(lastIndex) || lastIndex < firstIndex) return null;
        var middleIndex = Math.floor((firstIndex + lastIndex) / 2);
        var anchorIndex = Math.max(firstIndex, lastIndex - 1);
        function stableBar(index) {
          var value = bars.valueAt(index);
          return value ? value.slice(0, 6) : null;
        }
        return {
          currentSymbol: typeof chart.symbol === 'function' ? chart.symbol() : null,
          actualSymbol: typeof series.actualSymbol === 'function' ? series.actualSymbol() : null,
          barCount: lastIndex - firstIndex + 1,
          fingerprint: JSON.stringify([
            stableBar(firstIndex),
            stableBar(middleIndex),
            stableBar(anchorIndex)
          ])
        };
      } catch(e) { return null; }
    })()
  `);
}

export function seriesDataReady(before, after, expectedSymbol) {
  if (!after || !(Number(after.barCount) > 0)) return false;
  const expectedTicker = ticker(expectedSymbol);
  if (!expectedTicker || ticker(after.currentSymbol) !== expectedTicker) return false;
  if (after.actualSymbol && ticker(after.actualSymbol) !== expectedTicker) return false;

  const beforeTicker = ticker(before?.actualSymbol || before?.currentSymbol);
  if (!before || beforeTicker === expectedTicker) return true;
  return Boolean(before.fingerprint && after.fingerprint && before.fingerprint !== after.fingerprint);
}

export async function waitForSeriesDataSwitch({
  expectedSymbol,
  before,
  timeoutMs = 10_000,
  pollMs = 200,
  _deps,
} = {}) {
  const evaluate = _deps?.evaluate || _evaluate;
  const snapshot = _deps?.readSeriesSnapshot || (() => readSeriesSnapshot(evaluate));
  const sleep = _deps?.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 10_000);

  while (Date.now() <= deadline) {
    const after = await snapshot();
    if (seriesDataReady(before, after, expectedSymbol)) return true;
    await sleep(Math.max(0, Number(pollMs) || 0));
  }
  return false;
}

export async function getState({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const state = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var studies = [];
      try {
        var allStudies = chart.getAllStudies();
        studies = allStudies.map(function(s) {
          return { id: s.id, name: s.name || s.title || 'unknown' };
        });
      } catch(e) {}
      return {
        symbol: chart.symbol(),
        resolution: chart.resolution(),
        chartType: chart.chartType(),
        studies: studies,
      };
    })()
  `);
  return { success: true, ...state };
}

export function symbolForChartSet(symbol) {
  return String(symbol || '').trim().replace(/^([^:]+)_(?:DLY|DL):/i, '$1:');
}

export async function setSymbol({ symbol, _deps }) {
  const { evaluate, evaluateAsync, waitForChartReady } = _resolve(_deps);
  const chartSymbol = symbolForChartSet(symbol);
  const before = await readSeriesSnapshot(evaluate);
  await evaluateAsync(`
    (function() {
      var chart = ${CHART_API};
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(chartSymbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);
  const ready = await waitForChartReady(symbol);
  const dataReady = await waitForSeriesDataSwitch({
    expectedSymbol: chartSymbol,
    before,
    _deps,
  });
  if (!dataReady) {
    throw new Error(`CHART_SYMBOL_DATA_STALE: ${chartSymbol} title changed but main-series bars did not.`);
  }
  return { success: true, symbol, chart_symbol: chartSymbol, chart_ready: ready, series_data_ready: true };
}

export async function setTimeframe({ timeframe, _deps }) {
  const { evaluate, waitForChartReady } = _resolve(_deps);
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setResolution(${safeString(timeframe)}, {});
    })()
  `);
  const ready = await waitForChartReady(null, timeframe);
  return { success: true, timeframe, chart_ready: ready };
}

export async function setType({ chart_type, _deps }) {
  const { evaluate } = _resolve(_deps);
  const typeMap = {
    'Bars': 0, 'Candles': 1, 'Line': 2, 'Area': 3,
    'Renko': 4, 'Kagi': 5, 'PointAndFigure': 6, 'LineBreak': 7,
    'HeikinAshi': 8, 'HollowCandles': 9,
  };
  const typeNum = typeMap[chart_type] ?? Number(chart_type);
  if (isNaN(typeNum) || typeNum < 0 || typeNum > 9 || !Number.isInteger(typeNum)) {
    throw new Error(`Unknown chart type: ${chart_type}. Use a name (Candles, Line, etc.) or number (0-9).`);
  }
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setChartType(${typeNum});
    })()
  `);
  return { success: true, chart_type, type_num: typeNum };
}

export async function manageIndicator({ action, indicator, entity_id, inputs: inputsRaw, _deps }) {
  const { evaluate } = _resolve(_deps);
  const inputs = inputsRaw ? (typeof inputsRaw === 'string' ? JSON.parse(inputsRaw) : inputsRaw) : undefined;

  if (action === 'add') {
    const inputArr = inputs ? Object.entries(inputs).map(([k, v]) => ({ id: k, value: v })) : [];
    const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.createStudy(${safeString(indicator)}, false, false, ${JSON.stringify(inputArr)});
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));
    const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
    const newIds = (after || []).filter(id => !(before || []).includes(id));
    return { success: newIds.length > 0, action: 'add', indicator, entity_id: newIds[0] || null, new_study_count: newIds.length };
  } else if (action === 'remove') {
    if (!entity_id) throw new Error('entity_id required for remove action. Use chart_get_state to find study IDs.');
    await evaluate(`
      (function() {
        var chart = ${CHART_API};
        chart.removeEntity(${safeString(entity_id)});
      })()
    `);
    return { success: true, action: 'remove', entity_id };
  } else {
    throw new Error('action must be "add" or "remove"');
  }
}

export async function getVisibleRange() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      return { visible_range: chart.getVisibleRange(), bars_range: chart.getVisibleBarsRange() };
    })()
  `);
  return { success: true, visible_range: result.visible_range, bars_range: result.bars_range };
}

export async function getSeriesTimeRange({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API};
        var bars = chart._chartWidget.model().mainSeries().bars();
        if (!bars || typeof bars.firstIndex !== 'function' || typeof bars.lastIndex !== 'function') return null;
        var first = bars.valueAt(bars.firstIndex());
        var last = bars.valueAt(bars.lastIndex());
        if (!first || !last) return null;
        return {from: first[0], to: last[0]};
      } catch(e) { return null; }
    })()
  `);
  return {
    success: !!result,
    source: 'chart_series',
    from: result?.from ?? null,
    to: result?.to ?? null,
  };
}

export async function setVisibleRange({ from, to, _deps }) {
  const { evaluate } = _resolve(_deps);
  const f = requireFinite(from, 'from');
  const t = requireFinite(to, 'to');
  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${f} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${t}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  const actual = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      try { var r = chart.getVisibleRange(); return { from: r.from || 0, to: r.to || 0 }; }
      catch(e) { return { from: 0, to: 0, error: e.message }; }
    })()
  `);
  return { success: true, requested: { from, to }, actual: actual || { from: 0, to: 0 } };
}

export async function scrollToDate({ date }) {
  let timestamp;
  if (/^\d+$/.test(date)) timestamp = Number(date);
  else timestamp = Math.floor(new Date(date).getTime() / 1000);
  if (isNaN(timestamp)) throw new Error(`Could not parse date: ${date}. Use ISO format (2024-01-15) or unix timestamp.`);

  const resolution = await evaluate(`${CHART_API}.resolution()`);
  let secsPerBar = 60;
  const res = String(resolution);
  if (res === 'D' || res === '1D') secsPerBar = 86400;
  else if (res === 'W' || res === '1W') secsPerBar = 604800;
  else if (res === 'M' || res === '1M') secsPerBar = 2592000;
  else { const mins = parseInt(res, 10); if (!isNaN(mins)) secsPerBar = mins * 60; }

  const halfWindow = 25 * secsPerBar;
  const from = timestamp - halfWindow;
  const to = timestamp + halfWindow;

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var m = chart._chartWidget.model();
      var ts = m.timeScale();
      var bars = m.mainSeries().bars();
      var startIdx = bars.firstIndex();
      var endIdx = bars.lastIndex();
      var fromIdx = startIdx, toIdx = endIdx;
      for (var i = startIdx; i <= endIdx; i++) {
        var v = bars.valueAt(i);
        if (v && v[0] >= ${from} && fromIdx === startIdx) fromIdx = i;
        if (v && v[0] <= ${to}) toIdx = i;
      }
      ts.zoomToBarsRange(fromIdx, toIdx);
    })()
  `);
  await new Promise(r => setTimeout(r, 500));
  return { success: true, date, centered_on: timestamp, resolution, window: { from, to } };
}

export async function symbolInfo({ _deps } = {}) {
  const { evaluate } = _resolve(_deps);
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var info = null;
      try { info = chart.symbolExt(); } catch(e) {}
      if (!info) {
        var requestedSymbol = null;
        var actualSymbol = null;
        var seriesInfo = null;
        var seriesInvalid = null;
        var resolution = null;
        var chartType = null;
        var barCount = 0;
        try { requestedSymbol = typeof chart.symbol === 'function' ? chart.symbol() : null; } catch(e) {}
        try { resolution = typeof chart.resolution === 'function' ? chart.resolution() : null; } catch(e) {}
        try { chartType = typeof chart.chartType === 'function' ? chart.chartType() : null; } catch(e) {}
        try {
          var series = chart._chartWidget.model().mainSeries();
          actualSymbol = typeof series.actualSymbol === 'function' ? series.actualSymbol() : null;
          seriesInfo = typeof series.symbolInfo === 'function' ? series.symbolInfo() : null;
          seriesInvalid = typeof series.isSymbolInvalid === 'function' ? series.isSymbolInvalid() : null;
          var bars = series.bars();
          if (bars && typeof bars.firstIndex === 'function' && typeof bars.lastIndex === 'function') {
            var firstIndex = bars.firstIndex();
            var lastIndex = bars.lastIndex();
            if (Number.isFinite(firstIndex) && Number.isFinite(lastIndex) && lastIndex >= firstIndex) {
              barCount = lastIndex - firstIndex + 1;
            }
          }
        } catch(e) {}
        if (seriesInvalid !== true && actualSymbol && resolution && barCount > 0) {
          var resolvedSymbol = (seriesInfo && (seriesInfo.symbol || seriesInfo.full_name)) || actualSymbol;
          var separator = resolvedSymbol.indexOf(':');
          return {
            resolved: true,
            symbol: resolvedSymbol,
            full_name: (seriesInfo && seriesInfo.full_name) || resolvedSymbol,
            exchange: (seriesInfo && seriesInfo.exchange) || (separator > 0 ? resolvedSymbol.slice(0, separator) : null),
            description: (seriesInfo && seriesInfo.description) || null,
            type: (seriesInfo && seriesInfo.type) || null,
            pro_name: (seriesInfo && seriesInfo.pro_name) || resolvedSymbol,
            typespecs: (seriesInfo && seriesInfo.typespecs) || null,
            resolution: resolution,
            chart_type: chartType,
            bar_count: barCount,
            resolution_source: 'chart_series_fallback'
          };
        }
        return {
          resolved: false,
          requested_symbol: requestedSymbol,
          actual_symbol: actualSymbol,
          resolution: resolution,
          bar_count: barCount,
          series_invalid: seriesInvalid
        };
      }
      return {
        resolved: true,
        symbol: info.symbol, full_name: info.full_name, exchange: info.exchange,
        description: info.description, type: info.type, pro_name: info.pro_name,
        typespecs: info.typespecs, resolution: chart.resolution(), chart_type: chart.chartType(),
        resolution_source: 'symbol_ext'
      };
    })()
  `);
  return { success: result?.resolved === true, ...result };
}

export async function symbolSearch({ query, type }) {
  // Use TradingView's public symbol search REST API (works without auth)
  const params = new URLSearchParams({
    text: query,
    hl: '1',
    exchange: '',
    lang: 'en',
    search_type: type || '',
    domain: 'production',
  });

  const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
    headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
  });
  if (!resp.ok) throw new Error(`Symbol search API returned ${resp.status}`);
  const data = await resp.json();

  const strip = s => (s || '').replace(/<\/?em>/g, '');
  const results = (data.symbols || data || []).slice(0, 15).map(r => ({
    symbol: strip(r.symbol),
    description: strip(r.description),
    exchange: r.exchange || r.prefix || '',
    type: r.type || '',
    full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
  }));

  return { success: true, query, source: 'rest_api', results, count: results.length };
}
