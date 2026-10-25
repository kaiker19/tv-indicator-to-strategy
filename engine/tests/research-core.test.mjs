import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compileStrategy } from '../strategy_compiler.mjs';
import { validatePineStrategy } from '../pine_static_validator.mjs';
import { patchStrategyCosts } from '../costs.mjs';
import { normalizeStrategyMetrics } from '../strategy_metrics.mjs';
import { classifyEvaluation } from '../evaluation_contract.mjs';
import { buildRunSummary } from '../run_summary.mjs';
import { buildHtml, validateData } from '../report.mjs';

const engine = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = name => join(engine, 'fixtures', 'strategy_specs', name);
const fixture = name => JSON.parse(readFileSync(fixturePath(name), 'utf8'));

test('reviewed examples compile reproducibly with explicit costs and execution', () => {
  for (const name of ['simple-ema-cross.json', 'complex-bollinger-rsi.json']) {
    const spec = fixture(name);
    const result = compileStrategy(spec);
    assert.equal(result.source, compileStrategy(spec).source);
    assert.deepEqual(validatePineStrategy(result.source, { inputMap: result.inputMap }).errors, []);
    assert.match(result.source, /\/\/@version=6/);
    assert.ok(result.source.includes(`commission_value=${spec.costs.commissionPct}`));
    assert.ok(result.source.includes(`slippage=${spec.costs.slippageTicks}`));
    assert.match(result.source, /pyramiding=0/);
    assert.match(result.source, /process_orders_on_close=true/);
  }
});

test('ambiguous rules block compilation before any output is written', () => {
  assert.throws(() => compileStrategy(fixture('failure-ambiguous.json')), { code: 'SPEC_AMBIGUOUS' });
  const directory = mkdtempSync(join(tmpdir(), 'tv-spec-test-'));
  try {
    const output = join(directory, 'blocked.pine');
    const result = spawnSync(process.execPath, [join(engine, 'strategy_spec_cli.mjs'), 'compile', fixturePath('failure-ambiguous.json'), '--out', output], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(existsSync(output), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('explicit future data is blocked and pivot confirmation needs review', () => {
  const base = compileStrategy(fixture('simple-ema-cross.json')).source;
  const invalid = validatePineStrategy(`${base}\nfuture = request.security(syminfo.tickerid, "W", close, lookahead=barmerge.lookahead_on)\nbad = close[-1]\n`);
  assert.ok(invalid.errors.some(error => error.risk === 'lookahead_on'));
  assert.ok(invalid.errors.some(error => error.risk === 'negative_history_index'));
  const pivot = validatePineStrategy(`${base}\npivot = ta.pivothigh(high, 3, 3)\n`);
  assert.ok(pivot.warnings.some(warning => warning.risk === 'pivot'));
});

test('applying costs twice preserves the same trading rules', () => {
  const base = compileStrategy(fixture('simple-ema-cross.json')).source;
  const costs = { commission: 0.02, slippage: 3 };
  const first = patchStrategyCosts(base, costs);
  assert.deepEqual(first.errors, []);
  assert.equal(patchStrategyCosts(first.code, costs).code, first.code);
  assert.match(first.code, /commission_value=0.02/);
  assert.match(first.code, /slippage=3/);
  assert.equal(first.code.slice(first.code.indexOf('\n', first.code.indexOf('strategy('))), base.slice(base.indexOf('\n', base.indexOf('strategy('))));
});

test('total return includes open positions and requires a known denominator', () => {
  const raw = { initial_capital: 10000, performance: { all: { netProfit: 1000, netProfitPercent: 0.1 }, openPL: -250, openPLPercent: -0.9 } };
  const metrics = normalizeStrategyMetrics(raw);
  assert.equal(metrics.total_pnl, '7.5%');
  assert.equal(metrics.closed_pnl, '10%');
  assert.equal(metrics.open_pnl, '-2.5%');
  assert.equal(metrics.return_basis, 'total_equity');
  delete raw.initial_capital;
  const unknown = normalizeStrategyMetrics(raw);
  assert.equal(unknown.return_basis, 'unverified');
  assert.equal(unknown.total_pnl, undefined);
});

test('different evaluation windows or benchmarks cannot win an alpha ranking', () => {
  const run = { context: { symbol: 'NASDAQ:QQQ', timeframe: '1D', sourceDigest: 'example-source', costs: { commission: 0.02, slippage: 3 } }, range: { from: '2020-01-01', to: '2025-12-31', source: 'test_fixture', confidence: 'exact', precision: 'day' }, bhPct: 50, benchmarkSource: 'test_fixture' };
  assert.equal(classifyEvaluation({ runs: [run, structuredClone(run)], requestedObjective: 'alpha' }).comparisonStatus, 'comparable');
  for (const change of [candidate => { candidate.range.from = '2021-01-01'; }, candidate => { candidate.bhPct = 60; }]) {
    const candidate = structuredClone(run);
    change(candidate);
    const result = classifyEvaluation({ runs: [run, candidate], requestedObjective: 'alpha' });
    assert.equal(result.comparisonStatus, 'incompatible');
    assert.equal(result.effectiveObjective, 'risk_adjusted');
  }
});

test('an unverified final chart state cannot produce a completed report', () => {
  const pending = buildRunSummary({ manifest: { status: 'complete', mode: 'run', proof: { ok: false } } });
  assert.equal(pending.status, 'blocked');
  assert.equal(pending.nextRead.action, 'inspect_proof');
  const verified = buildRunSummary({ manifest: { status: 'complete', mode: 'run', proof: { ok: true } } });
  assert.equal(verified.status, 'complete');
  assert.equal(verified.nextRead.action, 'generate_report');
});

test('the portable report example stays a non-performance example and escapes titles', () => {
  const data = JSON.parse(readFileSync(join(engine, 'report_data.example.json'), 'utf8'));
  assert.equal(data.status, 'partial');
  assert.deepEqual(validateData(data).errors, []);
  data.title = '<script>unsafe_title()</script>';
  const html = buildHtml(data);
  assert.ok(!html.includes('<script>unsafe_title()</script>'));
  assert.ok(html.includes('&lt;script&gt;unsafe_title()&lt;/script&gt;'));
});
