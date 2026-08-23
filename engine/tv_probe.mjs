#!/usr/bin/env node
import CDP from 'chrome-remote-interface';
import { writeFileSync } from 'fs';
import { classifyFailure } from './runtime_protocol.mjs';

export const REQUIRED_TV_ENDPOINTS = Object.freeze([
  {
    name: 'chartApi',
    path: 'window.TradingViewApi._activeChartWidgetWV.value()',
    requiredFor: 'chart state, studies, symbol/timeframe changes, visible range',
  },
  {
    name: 'bottomWidgetBar',
    path: 'window.TradingView.bottomWidgetBar',
    requiredFor: 'opening Strategy Tester and legacy Pine Editor widget',
  },
  {
    name: 'chartWidgetCollection',
    path: 'window.TradingViewApi._chartWidgetCollection',
    requiredFor: 'fallback chart/widget discovery',
    optional: true,
  },
  {
    name: 'mainSeriesBars',
    path: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
    requiredFor: 'date/visible-range probes for OOS and walk-forward',
  },
  {
    name: 'strategyDataSources',
    path: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources()',
    requiredFor: 'strategy entity and performance API fallback',
    optional: true,
  },
  {
    name: 'alertService',
    path: 'window.TradingViewApi._alertService',
    requiredFor: 'future Alert/Webhook automation probes',
    optional: true,
  },
  {
    name: 'pineFacadeApi',
    path: 'https://pine-facade.tradingview.com/pine-facade',
    requiredFor: 'saved/community Pine script list/get/check',
    external: true,
  },
]);

export const REQUIRED_TV_SELECTORS = Object.freeze([
  {
    name: 'chartCanvas',
    selector: '[data-name="pane-canvas"], canvas',
    requiredFor: 'visual chart readiness',
  },
  {
    name: 'pineDialogButton',
    selector: '[data-name="pine-dialog-button"], [aria-label="Pine"]',
    requiredFor: 'opening the current right-side Pine Editor',
  },
  {
    name: 'pineDialog',
    selector: '[data-name="pine-dialog"]',
    requiredFor: 'scoping Pine controls in current TradingView UI',
    contextual: true,
  },
  {
    name: 'monacoEditor',
    selector: '.monaco-editor.pine-editor-monaco',
    requiredFor: 'reading/writing Pine source',
    contextual: true,
  },
  {
    name: 'pineTitleButton',
    selector: '[data-name="pine-dialog"] [class*=nameButton], [class*=nameButton]',
    requiredFor: 'creating a fresh strategy slot',
    contextual: true,
  },
  {
    name: 'pineAddToChart',
    selector: '[data-qa-id="add-script-to-chart"]',
    requiredFor: 'applying a newly injected strategy',
    contextual: true,
  },
  {
    name: 'pineUpdateOnChart',
    selector: '[data-qa-id="update-script-on-chart"]',
    requiredFor: 'updating an already-applied strategy',
    contextual: true,
  },
  {
    name: 'pineSaveButton',
    selector: '[class*=saveButton]',
    requiredFor: 'saving strategy to library after successful application',
    contextual: true,
  },
  {
    name: 'strategyTesterPanel',
    selector: '.bottom-widgetbar-content.backtesting, [class*="backtestingReport"], [data-name="backtesting"], [class*="strategyReport"]',
    requiredFor: 'reading Strategy Tester metrics',
  },
  {
    name: 'overviewTab',
    selector: 'role=tab text=/概览|Overview/',
    requiredFor: 'reading main KPI cards',
    textual: true,
  },
  {
    name: 'benchmarkTab',
    selector: 'role=tab text=/基准|Benchmarking/',
    requiredFor: 'reading buy-and-hold benchmark',
    textual: true,
  },
  {
    name: 'tradeAnalysisTab',
    selector: 'role=tab text=/交易分析|Trade Analysis/',
    requiredFor: 'reading average win/loss',
    textual: true,
  },
]);

export function buildTvStateProbeExpression() {
  return String.raw`(function(){
    function safe(fn, fallback) {
      try { return fn(); } catch (e) { return fallback === undefined ? { error: e.message } : fallback; }
    }
    function visible(el) {
      return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    }
    function describe(el) {
      if (!el) return { present: false, visible: false };
      var rect = safe(function(){ return el.getBoundingClientRect(); }, null);
      return {
        present: true,
        visible: visible(el),
        tag: el.tagName ? el.tagName.toLowerCase() : null,
        text: (el.textContent || '').trim().slice(0, 120),
        title: el.getAttribute ? (el.getAttribute('title') || null) : null,
        aria: el.getAttribute ? (el.getAttribute('aria-label') || null) : null,
        dataName: el.getAttribute ? (el.getAttribute('data-name') || null) : null,
        qaId: el.getAttribute ? (el.getAttribute('data-qa-id') || null) : null,
        rect: rect ? {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height)
        } : null
      };
    }
    function first(selector, root) {
      return (root || document).querySelector(selector);
    }
    function textTab(re) {
      var tabs = Array.from(document.querySelectorAll('[role=tab],button,[role=button]'));
      return tabs.find(function(t){
        if (!visible(t)) return false;
        var x = (t.textContent || '').trim();
        return x.length < 40 && re.test(x);
      }) || null;
    }
    function endpoint(path, fn) {
      return safe(function(){
        var value = fn();
        return { present: value !== undefined && value !== null, type: typeof value, path: path };
      }, { present: false, path: path, error: 'exception' });
    }

    var pineRoot = first('[data-name="pine-dialog"]') || document;
    var chart = safe(function(){ return window.TradingViewApi._activeChartWidgetWV.value(); }, null);
    var bottomWidgetBar = safe(function(){ return window.TradingView.bottomWidgetBar; }, null);
    var bars = safe(function(){ return chart._chartWidget.model().mainSeries().bars(); }, null);
    var visibleRange = chart ? safe(function(){ return chart.getVisibleRange(); }, null) : null;
    var barsRange = chart ? safe(function(){ return chart.getVisibleBarsRange(); }, null) : null;

    var endpoints = {
      chartApi: endpoint('window.TradingViewApi._activeChartWidgetWV.value()', function(){ return chart; }),
      bottomWidgetBar: endpoint('window.TradingView.bottomWidgetBar', function(){ return bottomWidgetBar; }),
      chartWidgetCollection: endpoint('window.TradingViewApi._chartWidgetCollection', function(){ return window.TradingViewApi._chartWidgetCollection; }),
      mainSeriesBars: endpoint('window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()', function(){ return bars; }),
      strategyDataSources: endpoint('window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources()', function(){ return chart._chartWidget.model().model().dataSources(); }),
      alertService: endpoint('window.TradingViewApi._alertService', function(){ return window.TradingViewApi._alertService; }),
      pineFacadeApi: { present: true, external: true, path: 'https://pine-facade.tradingview.com/pine-facade' }
    };

    var overviewTab = textTab(/概览|Overview/i);
    var benchmarkTab = textTab(/基准|Benchmarking/i);
    var tradeAnalysisTab = textTab(/交易分析|Trade Analysis/i);
    var strategyTesterPanel = first('.bottom-widgetbar-content.backtesting')
      || first('[class*="backtestingReport"]')
      || first('[data-name="backtesting"]')
      || first('[class*="strategyReport"]')
      || (overviewTab && overviewTab.closest('[data-name], [class*="backtest"], [class*="strategy"], [class*="report"]'))
      || overviewTab
      || benchmarkTab
      || tradeAnalysisTab;

    var selectors = {
      chartCanvas: describe(first('[data-name="pane-canvas"]') || first('canvas')),
      pineDialogButton: describe(first('[data-name="pine-dialog-button"]') || first('[aria-label="Pine"]')),
      pineDialog: describe(first('[data-name="pine-dialog"]')),
      monacoEditor: describe(first('.monaco-editor.pine-editor-monaco')),
      pineTitleButton: describe(first('[data-name="pine-dialog"] [class*=nameButton]') || first('[class*=nameButton]')),
      pineAddToChart: describe(first('[data-qa-id="add-script-to-chart"]', pineRoot)),
      pineUpdateOnChart: describe(first('[data-qa-id="update-script-on-chart"]', pineRoot)),
      pineSaveButton: describe(first('[class*=saveButton]', pineRoot)),
      strategyTesterPanel: describe(strategyTesterPanel),
      overviewTab: describe(overviewTab),
      benchmarkTab: describe(benchmarkTab),
      tradeAnalysisTab: describe(tradeAnalysisTab)
    };

    var dialogs = Array.from(document.querySelectorAll('[class*=popupDialog],[role=dialog]'))
      .filter(visible)
      .map(function(d) {
        return {
          text: (d.textContent || '').trim().slice(0, 320),
          inputs: d.querySelectorAll('input,textarea').length,
          buttons: Array.from(d.querySelectorAll('button,[role=button]')).map(function(b){
            return (b.textContent || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim();
          }).filter(Boolean).slice(0, 12)
        };
      });

    var studies = chart ? safe(function(){
      return chart.getAllStudies().map(function(s){
        return {
          id: s.id || null,
          name: s.name || s.title || 'unknown',
          metaInfoId: s.metaInfoId || null,
          pineFeatures: s.pineFeatures || null
        };
      });
    }, []) : [];

    var chartMethods = chart ? safe(function(){
      return Object.getOwnPropertyNames(Object.getPrototypeOf(chart))
        .filter(function(k){ return typeof chart[k] === 'function'; })
        .sort();
    }, []) : [];

    return {
      url: location.href,
      language: document.documentElement.lang || null,
      title: document.title,
      chart: chart ? {
        symbol: safe(function(){ return chart.symbol(); }, null),
        resolution: safe(function(){ return chart.resolution(); }, null),
        chartType: safe(function(){ return chart.chartType(); }, null),
        visibleRange: visibleRange,
        visibleBarsRange: barsRange,
        firstBarIndex: bars ? safe(function(){ return bars.firstIndex(); }, null) : null,
        lastBarIndex: bars ? safe(function(){ return bars.lastIndex(); }, null) : null,
        methods: chartMethods
      } : null,
      bottomWidgetBar: bottomWidgetBar ? safe(function(){
        return {
          activeWidgetName: bottomWidgetBar.activeWidgetName || bottomWidgetBar._activeWidgetName || null,
          widgets: Object.keys(bottomWidgetBar._widgets || {})
        };
      }, { error: 'bottomWidgetBar introspection failed' }) : null,
      endpoints: endpoints,
      selectors: selectors,
      dialogs: dialogs,
      studies: studies
    };
  })()`;
}

export function summarizeProbeState(state = {}) {
  const missingRequired = [];
  for (const endpoint of REQUIRED_TV_ENDPOINTS) {
    if (endpoint.optional || endpoint.external) continue;
    if (!state.endpoints?.[endpoint.name]?.present) missingRequired.push(`endpoint:${endpoint.name}`);
  }
  for (const selector of REQUIRED_TV_SELECTORS) {
    if (selector.contextual || selector.textual) continue;
    if (!state.selectors?.[selector.name]?.present) missingRequired.push(`selector:${selector.name}`);
  }

  const notes = [];
  const dialogs = state.dialogs || [];
  for (const dialog of dialogs) {
    if (/Save this script before adding|未保存更改的脚本无法添加|无法将未保存|无法添加到图表|unsaved.*add/i.test(dialog.text || '') && !dialog.inputs) {
      notes.push('检测到“保存后再添加到图表”弹窗：按钮可能只有“保存/Save”，不是“保存并添加到图表”。应点击保存后继续等待目标 strategy study 出现。');
    } else if (/Save script before switching|未保存的更改|未保存更改|您想保存|unsaved changes/i.test(dialog.text || '') && !dialog.inputs) {
      notes.push("检测到保存前确认弹窗：这不是脚本命名弹窗，应点“不保存/Don't save”或取消后重试。");
    } else if (/保存脚本|Save script/i.test(dialog.text || '') && dialog.inputs > 0) {
      notes.push('检测到脚本命名弹窗：可以填脚本名并保存。');
    }
  }
  if (state.selectors?.pineDialog?.present && !state.selectors?.monacoEditor?.present) {
    notes.push('Pine dialog 已打开但 Monaco 未就绪，通常需要等待或重新打开 Pine 面板。');
  }
  if (state.selectors?.pineDialog?.present && !state.selectors?.pineAddToChart?.present && !state.selectors?.pineUpdateOnChart?.present) {
    notes.push('Pine dialog 中未看到 add/update 按钮；可能当前脚本已保存、按钮延迟渲染，或 TV UI 改版。');
  }
  if ((state.studies || []).length === 0) {
    notes.push('图表上没有 studies；读取 Strategy Tester 前必须先确认目标 strategy 已应用。');
  }

  const summary = {
    status: missingRequired.length ? 'degraded' : 'ok',
    missingRequired,
    notes,
    studyCount: (state.studies || []).length,
    visibleDialogs: dialogs.length,
  };
  if (missingRequired.length) {
    summary.error = {
      code: 'TV_STATE_DEGRADED',
      severity: 'retryable',
      retryable: true,
      recommendedAction: '查看 missingRequired，按 public-runbook.md 的探针决策表只修复首个阻塞项，然后重新运行一次 tv_probe。',
    };
  }
  return summary;
}

async function runCli() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null;

  let targets;
  try {
    targets = await CDP.List();
  } catch (e) {
    const classified = classifyFailure(e.message || e);
    console.error(JSON.stringify({
      ok: false,
      error: 'CDP not reachable on 9222',
      ...classified,
      detail: e.message,
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const chartTarget = targets.find(t => t.url && /tradingview\.com\/chart/i.test(t.url))
    || targets.find(t => t.url && /tradingview/i.test(t.url));
  if (!chartTarget) {
    const classified = classifyFailure('No TradingView chart target found');
    console.error(JSON.stringify({
      ok: false,
      error: 'No TradingView chart target found',
      ...classified,
      targets: targets.map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url })),
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const client = await CDP({ target: chartTarget.webSocketDebuggerUrl || chartTarget.id });
  await client.Runtime.enable();
  const result = await client.Runtime.evaluate({
    expression: buildTvStateProbeExpression(),
    returnByValue: true,
    awaitPromise: true,
  });
  await client.close();
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'probe evaluation failed');
  }

  const state = result.result.value;
  const payload = {
    ok: true,
    timestamp: new Date().toISOString(),
    selectedTarget: {
      id: chartTarget.id,
      type: chartTarget.type,
      title: chartTarget.title,
      url: chartTarget.url,
    },
    targets: targets.map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url })),
    inventory: {
      endpoints: REQUIRED_TV_ENDPOINTS,
      selectors: REQUIRED_TV_SELECTORS,
    },
    summary: summarizeProbeState(state),
    state,
  };
  const json = JSON.stringify(payload, null, 2);
  if (outPath) writeFileSync(outPath, json);
  console.log(json);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch(e => {
    console.error('[FATAL]', e.message);
    process.exit(1);
  });
}
