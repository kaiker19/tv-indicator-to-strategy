/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';
import { hasCoreStrategyMetrics, normalizeStrategyMetrics } from '../strategy_metrics.mjs';

const MAX_OHLCV_BARS = 500;
const MAX_HISTORY_BARS = 20_000;
const MAX_TRADES = 500;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

function strategySourcePrelude(strategyName) {
  return `
    var chartApi = ${CHART_API};
    var chart = chartApi._chartWidget;
    var sources = chart.model().model().dataSources();
    var targetName = ${safeString(strategyName || '')};
    function sourceMeta(source) {
      try { return source.metaInfo ? source.metaInfo() : null; } catch(e) { return null; }
    }
    function sourceId(source) {
      try {
        var raw = typeof source.id === 'function' ? source.id() : source.id;
        return raw == null ? '' : String(raw);
      } catch(e) { return ''; }
    }
    function sourceName(source) {
      var meta = sourceMeta(source) || {};
      return String(meta.description || meta.shortDescription || '');
    }
    function isStrategySource(source) {
      var meta = sourceMeta(source) || {};
      var fullId = String(meta.fullId || meta.id || '');
      return Boolean(source.reportData && (source.ordersData || source.tradesData || /^StrategyScript\$/.test(fullId)));
    }
    var candidates = sources.filter(function(source) {
      return isStrategySource(source);
    });
    var studies = typeof chartApi.getAllStudies === 'function' ? chartApi.getAllStudies() : [];
    var targetIds = studies
      .filter(function(study) { return targetName && study.name === targetName; })
      .map(function(study) { return String(study.id); });
    var matches = targetName ? candidates.filter(function(source) {
      return targetIds.indexOf(sourceId(source)) >= 0 || sourceName(source) === targetName;
    }) : candidates;
    var strat = matches.length === 1 ? matches[0] : null;
    if (!strat && targetName && candidates.length === 1 && targetIds.length === 1) strat = candidates[0];
    var selectionError = strat ? null : (targetName
      ? 'Target strategy not found or ambiguous: ' + targetName
      : 'Strategy source is missing or ambiguous.');
  `;
}

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: Math.round((Math.max(...highs) - Math.min(...lows)) * 100) / 100,
      change: Math.round((last.close - first.open) * 100) / 100,
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

function finiteTimestamp(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a finite unix timestamp.`);
  return Math.floor(parsed);
}

function historyError(code, message) {
  return new Error(`${code}: ${message}`);
}

async function requestHistoryRange({ from, to, resolution }) {
  return evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.setTimeFrame({
        val: { type: 'time-range', from: ${from}, to: ${to} },
        res: ${safeString(resolution)}
      });
      return true;
    })()
  `);
}

async function readHistorySnapshot() {
  return evaluate(`
    (function() {
      var chart = ${CHART_API};
      var bars = ${BARS_PATH};
      if (!bars || typeof bars.firstIndex !== 'function' || typeof bars.lastIndex !== 'function') return null;
      var first = bars.valueAt(bars.firstIndex());
      var last = bars.valueAt(bars.lastIndex());
      return {
        first_time: first ? first[0] : null,
        last_time: last ? last[0] : null,
        total_bars: typeof bars.size === 'function' ? bars.size() : 0,
        resolution: chart && typeof chart.resolution === 'function' ? chart.resolution() : null
      };
    })()
  `);
}

async function readHistoryBars(maxBars) {
  return evaluate(`
    (function() {
      var bars = ${BARS_PATH};
      if (!bars || typeof bars.firstIndex !== 'function' || typeof bars.lastIndex !== 'function') return null;
      var total = typeof bars.size === 'function' ? bars.size() : 0;
      if (total > ${maxBars}) return { bars: [], total_bars: total, too_many: true };
      var result = [];
      for (var i = bars.firstIndex(); i <= bars.lastIndex(); i++) {
        var v = bars.valueAt(i);
        if (v) result.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
      }
      return { bars: result, total_bars: total };
    })()
  `);
}

export async function loadOhlcvHistory({
  from,
  to,
  resolution = '1D',
  maxBars = MAX_HISTORY_BARS,
  timeoutMs = 20_000,
  pollIntervalMs = 250,
  startToleranceSeconds = 86_400,
  forceRequest = false,
  _deps,
} = {}) {
  const start = finiteTimestamp(from, 'from');
  const end = finiteTimestamp(to, 'to');
  if (end < start) throw new TypeError('to must be greater than or equal to from.');
  const ceiling = Math.min(MAX_HISTORY_BARS, Math.max(1, Math.floor(Number(maxBars) || MAX_HISTORY_BARS)));
  const requestRange = _deps?.requestRange || requestHistoryRange;
  const readBars = _deps?.readBars || (async () => readHistoryBars(ceiling));
  const readSnapshot = _deps?.readSnapshot || (_deps?.readBars ? readBars : readHistorySnapshot);
  const sleep = _deps?.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const requestedResolution = String(resolution || '').trim().toUpperCase().replace(/^([DWM])$/, '1$1');
  const startTolerance = Math.max(0, Number(startToleranceSeconds) || 0);

  function snapshotState(snapshot) {
    const bars = Array.isArray(snapshot?.bars) ? snapshot.bars : null;
    const count = Number(snapshot?.total_bars ?? bars?.length ?? 0);
    const firstTime = Number(snapshot?.first_time ?? bars?.[0]?.time);
    const lastTime = Number(snapshot?.last_time ?? bars?.at(-1)?.time);
    const snapshotResolution = String(snapshot?.resolution || '').trim().toUpperCase().replace(/^([DWM])$/, '1$1');
    return {
      count,
      matchesResolution: Boolean(snapshotResolution) && snapshotResolution === requestedResolution,
      hasCoverage: Number.isFinite(firstTime) && Number.isFinite(lastTime)
        && firstTime <= start + startTolerance && lastTime >= end - 86_400,
    };
  }

  let latest = await readSnapshot();
  const initial = snapshotState(latest);
  const reuseCurrentRange = !forceRequest
    && initial.hasCoverage
    && initial.matchesResolution
    && initial.count > 0
    && initial.count <= ceiling;
  if (!reuseCurrentRange) {
    await requestRange({ from: start, to: end, resolution });
    latest = null;
  }

  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 20_000);
  let stablePolls = 0;
  let previousCount = reuseCurrentRange ? initial.count : null;
  let observedState = initial;
  while (Date.now() <= deadline) {
    latest = await readSnapshot();
    const state = snapshotState(latest);
    observedState = state;
    const count = state.count;
    stablePolls = state.hasCoverage
      && state.matchesResolution
      && count > 0
      && count <= ceiling
      && count === previousCount
      ? stablePolls + 1
      : 0;
    previousCount = count;
    if (stablePolls >= 1) break;
    await sleep(Math.max(0, Number(pollIntervalMs) || 0));
  }

  if (!latest || stablePolls < 1) {
    if (observedState.hasCoverage && observedState.matchesResolution && observedState.count > ceiling) {
      throw historyError('HISTORY_RANGE_TOO_LARGE', `Loaded ${observedState.count} bars; ceiling is ${ceiling}.`);
    }
    throw historyError('HISTORY_RANGE_UNAVAILABLE', `TradingView did not load stable ${resolution} coverage for ${start}..${end}.`);
  }
  const payload = Array.isArray(latest.bars) ? latest : await readBars();
  if (payload?.too_many || Number(payload?.total_bars || 0) > ceiling) {
    throw historyError('HISTORY_RANGE_TOO_LARGE', `Loaded ${payload?.total_bars || 0} bars; ceiling is ${ceiling}.`);
  }
  const bars = (payload?.bars || []).filter(bar => Number(bar.time) >= start && Number(bar.time) <= end);
  if (!bars.length) {
    throw historyError('HISTORY_RANGE_UNAVAILABLE', 'Loaded chart bars do not overlap the requested interval.');
  }
  return {
    success: true,
    source: reuseCurrentRange ? 'mainSeries.current-covered-range' : 'mainSeries.setTimeFrame.time-range',
    requested: { from: start, to: end, resolution },
    actual: {
      from: bars[0].time,
      to: bars.at(-1).time,
      bar_count: bars.length,
      loaded_bar_count: Number(payload?.total_bars ?? payload?.bars?.length ?? bars.length),
    },
    bars,
  };
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, input_definitions: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      try {
        var meta = study.metaInfo ? study.metaInfo() : null;
        if (meta && Array.isArray(meta.inputs)) {
          result.input_definitions = meta.inputs.map(function(input) {
            return { id: input.id, name: input.name || input.title || null, type: input.type || null };
          });
        }
      } catch(e) { result.input_definitions_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs,
    input_definitions: data?.input_definitions || null };
}

export async function getStrategyInventory({ _deps } = {}) {
  const runEvaluate = _deps?.evaluate || evaluate;
  const result = await runEvaluate(`
    (function() {
      try {
        var chartApi = ${CHART_API};
        var sources = chartApi._chartWidget.model().model().dataSources();
        var studies = typeof chartApi.getAllStudies === 'function' ? chartApi.getAllStudies() : [];
        function sourceMeta(source) {
          try { return source.metaInfo ? source.metaInfo() : null; } catch(e) { return null; }
        }
        function sourceId(source) {
          try {
            var raw = typeof source.id === 'function' ? source.id() : source.id;
            return raw == null ? '' : String(raw);
          } catch(e) { return ''; }
        }
        function isStrategySource(source) {
          var meta = sourceMeta(source) || {};
          var fullId = String(meta.fullId || meta.id || '');
          return Boolean(source.reportData && (source.ordersData || source.tradesData || /^StrategyScript\$/.test(fullId)));
        }
        var candidates = sources.filter(function(source) {
          return isStrategySource(source);
        });
        var rows = candidates.slice(0, 20).map(function(source) {
          var id = sourceId(source);
          var study = studies.find(function(item) { return String(item.id) === id; });
          var meta = sourceMeta(source) || {};
          return { id: id, name: String((study && study.name) || meta.description || meta.shortDescription || '') };
        });
        return { count: candidates.length, strategies: rows };
      } catch(e) { return { count: 0, strategies: [], error: e.message }; }
    })()
  `);
  return {
    success: !result?.error,
    count: Number(result?.count || 0),
    strategies: Array.isArray(result?.strategies) ? result.strategies : [],
    ...(result?.error ? { error: result.error } : {}),
  };
}

export async function getStrategyResults({ strategy_name, _deps } = {}) {
  const runEvaluate = _deps?.evaluate || evaluate;
  const results = await runEvaluate(`
    (function() {
      try {
        ${strategySourcePrelude(strategy_name)}
        if (!strat) return {metrics: {}, source: 'internal_api', strategy_name: targetName || null, error: selectionError};
        var metrics = {};
        if (strat.reportData) {
          var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
          if (rd && typeof rd === 'object') {
            if (typeof rd.value === 'function') rd = rd.value();
            if (rd) { var keys = Object.keys(rd); for (var k = 0; k < keys.length; k++) { var val = rd[keys[k]]; if (val !== null && val !== undefined && typeof val !== 'function') metrics[keys[k]] = val; } }
          }
        }
        if (Object.keys(metrics).length === 0 && strat.performance) {
          var perf = strat.performance();
          if (perf && typeof perf.value === 'function') perf = perf.value();
          if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { var pval = perf[pkeys[p]]; if (pval !== null && pval !== undefined && typeof pval !== 'function') metrics[pkeys[p]] = pval; } }
        }
        return {metrics: metrics, source: 'internal_api', strategy_name: targetName || sourceName(strat) || null};
      } catch(e) { return {metrics: {}, source: 'internal_api', error: e.message}; }
    })()
  `);
  const metrics = normalizeStrategyMetrics(results?.metrics || {});
  return { success: true, metric_count: Object.keys(metrics).length, core_complete: hasCoreStrategyMetrics(metrics), source: results?.source,
    strategy_name: results?.strategy_name || null, metrics, error: results?.error };
}

export async function getStrategyRangeCandidate({ strategy_name, _deps } = {}) {
  const runEvaluate = _deps?.evaluate || evaluate;
  const result = await runEvaluate(`
    (function() {
      try {
        ${strategySourcePrelude(strategy_name)}
        if (!strat) return {range_candidate: null, source: 'internal_api', strategy_name: targetName || null, error: selectionError};
        function unwrap(value) {
          if (value && typeof value.value === 'function') {
            try { return value.value(); } catch(e) { return value; }
          }
          return value;
        }
        function primitive(value) { return typeof value === 'number' || typeof value === 'string'; }
        function findRange(node, depth) {
          node = unwrap(node);
          if (!node || typeof node !== 'object' || depth > 3) return null;
          if (Array.isArray(node)) {
            return node.length === 2 && primitive(node[0]) && primitive(node[1])
              ? {from: node[0], to: node[1]}
              : null;
          }
          var fromKeys = ['from', 'start'];
          var toKeys = ['to', 'end'];
          var fromKey = fromKeys.find(function(key) { return Object.prototype.hasOwnProperty.call(node, key); });
          var toKey = toKeys.find(function(key) { return Object.prototype.hasOwnProperty.call(node, key); });
          if (fromKey && toKey && primitive(node[fromKey]) && primitive(node[toKey])) {
            return {from: node[fromKey], to: node[toKey]};
          }
          var containers = ['range', 'period', 'dateRange', 'timeRange'];
          for (var k = 0; k < containers.length; k++) {
            var key = containers[k];
            if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
            var found = findRange(node[key], depth + 1);
            if (found) return found;
          }
          return null;
        }
        var candidates = [];
        if (strat.reportData) candidates.push(typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData);
        if (strat.performance) candidates.push(typeof strat.performance === 'function' ? strat.performance() : strat.performance);
        for (var c = 0; c < candidates.length; c++) {
          var range = findRange(candidates[c], 0);
          if (range) return {range_candidate: range, source: 'internal_api', strategy_name: targetName || sourceName(strat) || null};
        }
        return {range_candidate: null, source: 'internal_api', strategy_name: targetName || sourceName(strat) || null};
      } catch(e) {
        return {range_candidate: null, source: 'internal_api', error: e.message};
      }
    })()
  `);
  return {
    success: true,
    source: result?.source || 'internal_api',
    strategy_name: result?.strategy_name || null,
    range_candidate: result?.range_candidate || null,
    error: result?.error,
  };
}

export async function getTrades({ strategy_name, max_trades, _deps } = {}) {
  const requestedLimit = Number(max_trades || 100);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 100, MAX_TRADES));
  const runEvaluate = _deps?.evaluate || evaluate;
  const result = await runEvaluate(`
    (function() {
      try {
        ${strategySourcePrelude(strategy_name)}
        if (!strat) return {trades: [], source: 'internal_api', strategy_name: targetName || null, error: selectionError};
        function unwrap(value) {
          if (value && typeof value.value === 'function') {
            try { return value.value(); } catch(e) { return value; }
          }
          return value;
        }
        function readDataset(name) {
          if (!strat[name]) return null;
          try {
            return unwrap(typeof strat[name] === 'function' ? strat[name]() : strat[name]);
          } catch(e) { return null; }
        }
        function plain(value, depth) {
          if (value === null || value === undefined) return value;
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
          if (typeof value === 'function' || depth >= 4) return undefined;
          if (Array.isArray(value)) {
            var rows = [];
            for (var a = 0; a < Math.min(value.length, 100); a++) {
              var item = plain(value[a], depth + 1);
              if (item !== undefined) rows.push(item);
            }
            return rows;
          }
          if (typeof value !== 'object') return undefined;
          var output = {};
          var keys = Object.keys(value).slice(0, 100);
          for (var k = 0; k < keys.length; k++) {
            var cleaned = plain(value[keys[k]], depth + 1);
            if (cleaned !== undefined) output[keys[k]] = cleaned;
          }
          return output;
        }
        var report = readDataset('reportData');
        var records = report && Array.isArray(report.trades) ? report.trades : null;
        var dataset = 'reportData.trades';
        if (!Array.isArray(records) || records.length === 0) {
          records = readDataset('tradesData');
          dataset = 'tradesData';
        }
        if (!Array.isArray(records) || records.length === 0) {
          records = readDataset('ordersData');
          dataset = 'ordersData';
        }
        if ((!Array.isArray(records) || records.length === 0) && Array.isArray(strat._orders)) {
          records = strat._orders;
          dataset = '_orders';
        }
        if (!Array.isArray(records)) return {trades: [], source: 'internal_api', strategy_name: targetName || sourceName(strat) || null, error: 'Strategy trade data returned non-array.'};
        var rows = [];
        for (var t = 0; t < Math.min(records.length, ${limit}); t++) {
          var row = plain(records[t], 0);
          if (row && typeof row === 'object') rows.push(row);
        }
        return {trades: rows, dataset: dataset, source: 'internal_api', strategy_name: targetName || sourceName(strat) || null};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return {
    success: !result?.error,
    trade_count: result?.trades?.length || 0,
    source: result?.source,
    dataset: result?.dataset || null,
    strategy_name: result?.strategy_name || null,
    trades: result?.trades || [],
    error: result?.error,
  };
}

export async function getEquity() {
  const equity = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (s.reportData || s.performance)) { strat = s; break; }
        }
        if (!strat) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var data = [];
        if (strat.equityData) {
          var eq = typeof strat.equityData === 'function' ? strat.equityData() : strat.equityData;
          if (eq && typeof eq.value === 'function') eq = eq.value();
          if (Array.isArray(eq)) data = eq;
        }
        if (data.length === 0 && strat.bars) {
          var bars = typeof strat.bars === 'function' ? strat.bars() : strat.bars;
          if (bars && typeof bars.lastIndex === 'function') {
            var end = bars.lastIndex(); var start = bars.firstIndex();
            for (var i = start; i <= end; i++) { var v = bars.valueAt(i); if (v) data.push({time: v[0], equity: v[1], drawdown: v[2] || null}); }
          }
        }
        if (data.length === 0) {
          var perfData = {};
          if (strat.performance) {
            var perf = strat.performance();
            if (perf && typeof perf.value === 'function') perf = perf.value();
            if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { if (/equity|drawdown|profit|net/i.test(pkeys[p])) perfData[pkeys[p]] = perf[pkeys[p]]; } }
          }
          if (Object.keys(perfData).length > 0) return {data: [], equity_summary: perfData, source: 'internal_api', note: 'Full equity curve not available via API; equity summary metrics returned instead.'};
        }
        return {data: data, source: 'internal_api'};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: true, data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [], equity_summary: equity?.equity_summary, note: equity?.note, error: equity?.error };
}

export async function getQuote({ symbol } = {}) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var sym = ${safeString(symbol || '')};
      if (!sym) { try { sym = api.symbol(); } catch(e) {} }
      if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
      var ext = {};
      try { ext = api.symbolExt() || {}; } catch(e) {}
      var bars = ${BARS_PATH};
      var quote = { symbol: sym };
      if (bars && typeof bars.lastIndex === 'function') {
        var last = bars.valueAt(bars.lastIndex());
        if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
      }
      try {
        var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
        var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
        if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
        if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
      } catch(e) {}
      try {
        var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
        if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
      } catch(e) {}
      if (ext.description) quote.description = ext.description;
      if (ext.exchange) quote.exchange = ext.exchange;
      if (ext.type) quote.type = ext.type;
      return quote;
    })()
  `);
  if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
  return { success: true, ...data };
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ name: name, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = v.y1 != null ? Math.round(v.y1 * 100) / 100 : null;
      const y2 = v.y2 != null ? Math.round(v.y2 * 100) / 100 : null;
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = v.y != null ? Math.round(v.y * 100) / 100 : null;
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1, v.y2) * 100) / 100 : null;
      const low = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1, v.y2) * 100) / 100 : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
