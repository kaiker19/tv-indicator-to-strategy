import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

function normalizedResolution(value) {
  return String(value || '').trim().toUpperCase().replace(/^([DWM])$/, '1$1');
}

function ticker(value) {
  return String(value || '').trim().toUpperCase().split(':').at(-1);
}

export function chartStateMatches({ currentSymbol, currentResolution }, expectedSymbol = null, expectedTf = null) {
  const symbolMatches = !expectedSymbol
    || (ticker(currentSymbol) && ticker(currentSymbol) === ticker(expectedSymbol));
  const timeframeMatches = !expectedTf
    || normalizedResolution(currentResolution) === normalizedResolution(expectedTf);
  return Boolean(symbolMatches && timeframeMatches);
}

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();
  let readyPolls = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        // Check for loading spinner
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        // Read the chart API first. DOM titles omit/translate exchange prefixes and
        // can lag one symbol switch behind in desktop builds.
        var barCount = -1;
        var currentSymbol = '';
        var currentResolution = '';
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          currentSymbol = typeof chart.symbol === 'function' ? chart.symbol() : '';
          currentResolution = typeof chart.resolution === 'function' ? chart.resolution() : '';
          var seriesBars = chart._chartWidget.model().mainSeries().bars();
          barCount = seriesBars && typeof seriesBars.size === 'function' ? seriesBars.size() : -1;
        } catch {}

        if (!currentSymbol) {
          var symbolEl = document.querySelector('[data-name="legend-source-title"]')
            || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
          currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';
        }
        if (barCount < 0) barCount = document.querySelectorAll('[class*="bar"]').length;

        return {
          isLoading: !!isLoading,
          barCount: barCount,
          currentSymbol: currentSymbol,
          currentResolution: currentResolution
        };
      })()
    `);

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      readyPolls = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    if (!chartStateMatches(state, expectedSymbol, expectedTf)) {
      readyPolls = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Chart switching may keep backfilling the default viewport for several
    // seconds. Two matching API polls with data are sufficient here; callers
    // that need full-range history perform their own coverage/stability check.
    readyPolls = state.barCount > 0 ? readyPolls + 1 : 0;
    if (readyPolls >= 2) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Timeout — return true anyway, caller should verify
  return false;
}
