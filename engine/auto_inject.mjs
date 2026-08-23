// 端到端：Pine 注入 → 应用到图表 → 展开 Strategy Tester → 抓核心数字 → 截图
// 用法: node auto_inject.mjs <pine_file> [strategy_name]
// strategy_name 缺省时自动从 strategy("...") 第一个参数提取
import CDP from 'chrome-remote-interface';
import * as ui from './core/ui.js';
import * as pine from './core/pine.js';
import * as data from './core/data.js';
import * as chart from './core/chart.js';
import * as indicators from './core/indicators.js';
import { readFileSync, writeFileSync, existsSync, openSync, writeSync, closeSync, unlinkSync, appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildHeatmapSlice } from './heatmap.mjs';
import { buildEpisodeAudit } from './episode_audit.mjs';
import { patchStrategyCosts } from './costs.mjs';
import {
  findDiscardUnsavedChangesButtonExpression,
  findPineApplyButtonExpression,
  findSaveBeforeAddButtonExpression,
  findSaveScriptNamingDialogExpression,
} from './dialogs.mjs';
import { buildScanSummary, scanObjectiveFromMetrics } from './scan_summary.mjs';
import { buildCoarseGrid, buildOptimizationSummary, planLocalRefinement, resolveOptimizationBudget } from './optimizer.mjs';
import { buildOosSummary } from './oos.mjs';
import { summarizeValidationRows } from './validation.mjs';
import { assertRuntimeMetricsCredible, normalizeNoTradeMetrics } from './metrics_state.mjs';
import { hasCoreStrategyMetrics } from './strategy_metrics.mjs';
import {
  buildRunManifest,
  completeStage,
  failManifest,
  finishManifest,
  verifyProofContext,
} from './runtime_protocol.mjs';
import { buildRunSummary } from './run_summary.mjs';
import { classifyEvaluation, normalizeContext, normalizeRange } from './evaluation_contract.mjs';
import { parseRangeText, rangeFromAllowlistedReport, rangeFromChartSeries } from './range_evidence.mjs';
import { buildStudyRecord, evaluateReuse, sourceDigest } from './reuse_guard.mjs';
import { resolveStateDir } from './state_paths.mjs';
import {
  buildInputTitleMap,
  mergeProvenInputs,
  parseInputAssignment,
  verifySourceInputValues,
} from './source_inputs.mjs';
const ENGINE_DIR = dirname(fileURLToPath(import.meta.url));

// 输出目录可由 TV_SKILL_OUTPUT_DIR 覆盖，默认 ~/.tv-skill（可分发：不含任何用户专属硬编码路径）
const OUTPUT_DIR = process.env.TV_SKILL_OUTPUT_DIR || join(homedir(), '.tv-skill');
mkdirSync(OUTPUT_DIR, { recursive: true });
const STATE_DIR = resolveStateDir();
mkdirSync(STATE_DIR, { recursive: true });
const SCAN_JSONL = join(OUTPUT_DIR, 'scan_results.jsonl');
const HEATMAP_JSON = join(OUTPUT_DIR, 'heatmap.json');
const OPTIMIZATION_JSON = join(OUTPUT_DIR, 'optimization.json');
const PROOF_PNG = join(OUTPUT_DIR, 'inject_proof.png');
const RUN_MANIFEST_JSON = join(OUTPUT_DIR, 'run_manifest.json');
const RUN_SUMMARY_JSON = join(OUTPUT_DIR, 'run_summary.json');
const LAST_STUDY_FILE = join(STATE_DIR, 'last_study.txt'); // 跨输出目录记上次策略，下次运行前移除防堆积
const LAST_STUDY_META_FILE = join(STATE_DIR, 'last_study.json');

const LOCK_PATH = '/tmp/auto_inject.lock';
function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    try {
      const pid = parseInt(readFileSync(LOCK_PATH, 'utf8').trim(), 10);
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); }
        catch { unlinkSync(LOCK_PATH); }
      }
    } catch {}
  }
  if (existsSync(LOCK_PATH)) {
    const pid = readFileSync(LOCK_PATH, 'utf8').trim();
    console.error(`auto_inject already running (pid ${pid}). Abort to avoid concurrent CDP. Remove ${LOCK_PATH} if stale.`);
    process.exit(2);
  }
  const fd = openSync(LOCK_PATH, 'wx');
  writeSync(fd, String(process.pid));
  closeSync(fd);
}
function releaseLock() {
  try { if (existsSync(LOCK_PATH) && readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK_PATH); } catch {}
}
acquireLock();
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });
process.on('uncaughtException', (e) => { console.error(e); releaseLock(); process.exit(1); });

// CLI 解析: <pine_file> [name] [--symbol X | --symbols A,B,C] [--timeframe Y] [--input key=value]...
const _argv = process.argv.slice(2);
const _pos = [];
const flags = { symbol: null, symbols: null, timeframe: null, inputs: {}, sourceInputs: {}, keep: false, scans: [], optimize: [], objective: 'risk_adjusted', autoTune: null, oos: null, walkForward: null, episodeAudit: false, selftest: false, reuse: false, cleanup: false, budget: null, slippage: null, commission: null, commissionType: 'percent', saveName: null };
for (let i = 0; i < _argv.length; i++) {
  const a = _argv[i];
  if (a === '--symbol')         flags.symbol = _argv[++i];
  else if (a === '--symbols')   flags.symbols = (_argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
  else if (a === '--timeframe') flags.timeframe = _argv[++i];
  else if (a === '--save-name') flags.saveName = _argv[++i];
  else if (a === '--keep')      flags.keep = true;   // 兼容保留（现已是默认行为）
  else if (a === '--cleanup')   flags.cleanup = true; // 反向：跑完移除策略，留干净图表
  else if (a === '--reuse')     flags.reuse = true;
  else if (a === '--episode-audit') flags.episodeAudit = true;
  else if (a === '--selftest')  { flags.selftest = true; flags.cleanup = true; } // 自检自己清理，验"无残留"断言
  else if (a === '--objective') {
    const o = _argv[++i];
    if (!['risk_adjusted', 'net_pnl', 'profit_factor', 'alpha', 'win_rate_confidence'].includes(o)) { console.error(`bad --objective: ${o} (risk_adjusted|net_pnl|profit_factor|alpha|win_rate_confidence)`); process.exit(1); }
    flags.objective = o;
  }
  else if (a === '--budget') {
    flags.budget = parseInt(_argv[++i], 10);
    if (!Number.isFinite(flags.budget) || flags.budget < 1) { console.error('bad --budget: 期望正整数'); process.exit(1); }
  }
  else if (a === '--slippage') {
    flags.slippage = parseInt(_argv[++i], 10);
    if (!Number.isFinite(flags.slippage) || flags.slippage < 0) { console.error('bad --slippage: 期望非负整数 ticks'); process.exit(1); }
  }
  else if (a === '--commission') {
    flags.commission = parseFloat(_argv[++i]);
    if (!Number.isFinite(flags.commission) || flags.commission < 0) { console.error('bad --commission: 期望非负数字百分比'); process.exit(1); }
  }
  else if (a === '--commission-type') {
    const t = _argv[++i];
    if (!['percent', 'cash_per_contract', 'percent_of_equity'].includes(t)) { console.error(`bad --commission-type: ${t} (percent|cash_per_contract|percent_of_equity)`); process.exit(1); }
    flags.commissionType = t;
  }
  else if (a === '--scan') {
    // --scan Name=start..end:step   例: --scan Oversold=10..40:5
    const spec = _argv[++i] || '';
    const m = spec.match(/^(.+?)=(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)(?::(-?\d+(?:\.\d+)?))?$/);
    if (!m) { console.error(`bad --scan spec: ${spec} (期望 Name=start..end:step)`); process.exit(1); }
    flags.scans.push({ name: m[1], start: parseFloat(m[2]), end: parseFloat(m[3]), step: parseFloat(m[4] || '1') });
  }
  else if (a === '--optimize') {
    // P2 deep mode: explicit opt-in. Same axis syntax as --scan.
    const spec = _argv[++i] || '';
    const m = spec.match(/^(.+?)=(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)(?::(-?\d+(?:\.\d+)?))?$/);
    if (!m) { console.error(`bad --optimize spec: ${spec} (期望 Name=start..end:step)`); process.exit(1); }
    flags.optimize.push({ name: m[1], start: parseFloat(m[2]), end: parseFloat(m[3]), step: parseFloat(m[4] || '1') });
  }
  else if (a === '--oos') {
    const v = _argv[++i];
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) { console.error('bad --oos: 期望 1..99 的训练集百分比，例如 70'); process.exit(1); }
    flags.oos = n;
  }
  else if (a === '--walk-forward') {
    const n = parseInt(_argv[++i], 10);
    if (!Number.isFinite(n) || n < 2) { console.error('bad --walk-forward: 期望 >=2 的窗口数'); process.exit(1); }
    flags.walkForward = n;
  }
  else if (a === '--auto-tune') {
    // --auto-tune Name=min..max   引擎内部自动粗→细，弱 Agent 一条命令拿最优参数
    const spec = _argv[++i] || '';
    const m = spec.match(/^(.+?)=(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/);
    if (!m) { console.error(`bad --auto-tune spec: ${spec} (期望 Name=min..max)`); process.exit(1); }
    flags.autoTune = { name: m[1], min: parseFloat(m[2]), max: parseFloat(m[3]) };
  }
  else if (a === '--input') {
    const [k, val] = parseInputAssignment(_argv[++i]);
    flags.inputs[k] = val;
  }
  else if (a === '--source-input') {
    const [k, val] = parseInputAssignment(_argv[++i]);
    flags.sourceInputs[k] = val;
  }
  else _pos.push(a);
}
// --selftest: 用捆绑的参考策略 + 固定 symbol，无需用户传 pine_file
if (flags.selftest) {
  if (!_pos[0]) _pos[0] = join(ENGINE_DIR, 'fixtures', 'crsi_reference.pine');
  if (!flags.symbol && !flags.symbols) flags.symbol = 'BATS:SOXX';
}
const pineFile = _pos[0];
if (!pineFile) {
  console.error('usage: node auto_inject.mjs <pine_file> [name] [--symbol S] [--timeframe TF] [--input key=value] [--source-input key=value]...');
  console.error('       node auto_inject.mjs <pine_file> --optimize Name=start..end:step [--budget N] [--oos 70]');
  console.error('       node auto_inject.mjs --selftest   端到端自检（捆绑策略 + BATS:SOXX）');
  process.exit(1);
}
const rawCode = readFileSync(pineFile, 'utf8');
const titleMatch = rawCode.match(/strategy\s*\(\s*["']([^"']+)["']/) || rawCode.match(/strategy\s*\(\s*title\s*=\s*["']([^"']+)["']/);
const requestedName = _pos[1] || null;
if (requestedName && titleMatch?.[1] && requestedName !== titleMatch?.[1]) {
  console.error(`TITLE_NAME_MISMATCH: CLI name "${requestedName}" does not match Pine strategy title "${titleMatch[1]}". Omit the CLI name or make both values identical.`);
  process.exit(1);
}
const scriptName = requestedName || titleMatch?.[1] || 'AutoStrategy';
const tag = `AUTO_${Date.now()}`;
const costPatch = patchStrategyCosts(rawCode, flags);
costPatch.warnings.forEach(w => console.error(`WARN: ${w}`));
if (costPatch.errors.length) {
  costPatch.errors.forEach(e => console.error(`ERROR: ${e}`));
  process.exit(1);
}
const code = costPatch.code + `\n\n// AUTO_TAG: ${tag}\n`;
const strategyDigest = sourceDigest(costPatch.code);

const runMode = flags.selftest ? 'selftest' : flags.optimize.length ? 'optimize' : flags.scans.length ? 'scan' : flags.autoTune ? 'auto_tune' : 'run';
const primarySymbol = (flags.symbols && flags.symbols[0]) || flags.symbol || null;
const runManifest = buildRunManifest({
  mode: runMode,
  scriptName,
  primarySymbol,
  timeframe: flags.timeframe,
  costs: costPatch.costs,
  outputDir: OUTPUT_DIR,
});
let currentStage = 'startup';
let lastAppliedInputs = {};
let verifiedSourceInputs = {};
let proofExpectedParams = mergeProvenInputs(flags.sourceInputs, flags.inputs);
const summaryRuns = [];
const candidateEvaluationEvidence = [];
const runEvaluationEvidence = [];
let optimizationSummary = null;
let currentHeatmapPath = null;
let evaluationSummary = null;
function writeRunSummary() {
  const summary = buildRunSummary({
    manifest: runManifest,
    pineFile,
    sourceTag: tag,
    runs: summaryRuns,
    optimization: optimizationSummary,
    evaluation: evaluationSummary,
    heatmapPath: currentHeatmapPath,
    manifestPath: RUN_MANIFEST_JSON,
  });
  writeFileSync(RUN_SUMMARY_JSON, JSON.stringify(summary, null, 2));
}

function updateEvaluationSummary() {
  const evidence = candidateEvaluationEvidence.length
    ? candidateEvaluationEvidence
    : runEvaluationEvidence.slice(0, 1);
  evaluationSummary = classifyEvaluation({
    runs: evidence,
    requestedObjective: flags.objective,
    requestedRange: { mode: 'full_history' },
  });
  runManifest.evaluation = evaluationSummary;
  runManifest.evaluationEvidence = {
    candidates: candidateEvaluationEvidence,
    runs: runEvaluationEvidence,
  };
  return evaluationSummary;
}
function writeRunManifest() {
  writeFileSync(RUN_MANIFEST_JSON, JSON.stringify(runManifest, null, 2));
  writeRunSummary();
}
writeRunManifest();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11,19)}]`, ...a);

async function probe(client, expr) {
  const r = await client.Runtime.evaluate({expression: expr, returnByValue: true, awaitPromise: true});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

async function getChartClient() {
  currentStage = 'probe';
  let targets;
  try { targets = await CDP.List(); }
  catch (e) { throw new Error('CDP not reachable on 9222. Launch TV with TVD_DEBUGMODE=true ... --remote-debugging-port=9222'); }
  let chart = targets.find(t => t.url.includes('tradingview.com/chart'));
  const errTab = targets.find(t => t.url.includes('error-view'));
  if (!chart && errTab) {
    log('  recovering from error-view tab...');
    const c = await CDP({target: errTab.webSocketDebuggerUrl});
    await c.Page.enable();
    await c.Page.navigate({url: 'https://cn.tradingview.com/chart/'});
    await sleep(8000);
    await c.close();
    chart = (await CDP.List()).find(t => t.url.includes('tradingview.com/chart'));
  }
  if (!chart) throw new Error('No TradingView chart tab found');
  const client = await CDP({target: chart.webSocketDebuggerUrl});
  completeStage(runManifest, 'probe', { evidence: { chartTarget: true, url: chart.url } });
  writeRunManifest();
  return client;
}

async function checkTVError(client, label='') {
  return await probe(client, `Array.from(document.querySelectorAll('div,span')).some(d=>d.offsetWidth>0 && d.children.length===0 && /请求错误|无法将.*添加|加载失败/.test(d.textContent) && d.textContent.length<200)`);
}

async function dismissModalIfAny(client) {
  await probe(client, `(function(){
    var dlg = Array.from(document.querySelectorAll('[class*=popupDialog],[role=dialog]')).find(d=>d.offsetWidth>0);
    if (!dlg) return false;
    var btn = dlg.querySelector('[data-name=close]') || Array.from(dlg.querySelectorAll('button')).find(b=>['关闭','Cancel','取消'].includes(b.textContent.trim()));
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(600);
}

async function dismissOnboarding(client) {
  // TV 不定期推送引导浮层（如"策略测试器菜单已移动…Got it"），会挡住 sub-tab 交互导致 B&H/avg 读 null。
  // 点掉任何 "Got it / 知道了 / 我知道了 / 好的" 这类确认按钮。
  const n = await probe(client, `(function(){
    var btns = Array.from(document.querySelectorAll('button, [role=button]')).filter(function(b){
      if (!b.offsetWidth) return false;
      var t = (b.textContent||'').trim();
      return /^(Got it|知道了|我知道了|好的|明白了|OK)$/i.test(t);
    });
    btns.forEach(function(b){ b.click(); });
    return btns.length;
  })()`);
  if (n > 0) { log(`  dismissed ${n} onboarding 浮层`); await sleep(600); }
  return n;
}

async function forceFreshStrategySlot(client) {
  // 通过 DOM 坐标点 title button dropdown → 创建新的 → 策略，强制新 "无标题脚本" 槽
  // chord shortcut ⌘K, ⌘S 不稳定，改走 UI 路径。
  log('  open title dropdown → 创建新的 → 策略');
  const click = async (x, y) => {
    await client.Input.dispatchMouseEvent({type:'mouseMoved', x, y});
    await sleep(80);
    await client.Input.dispatchMouseEvent({type:'mousePressed', x, y, button:'left', clickCount:1});
    await client.Input.dispatchMouseEvent({type:'mouseReleased', x, y, button:'left', clickCount:1});
  };
  const hover = async (x, y) => await client.Input.dispatchMouseEvent({type:'mouseMoved', x, y});
  // 文本定位叶子节点（多语言正则匹配，配合 pollCoords 轮询，治冷启动菜单渲染慢）
  const coordsOf = async (reSrc) => probe(client, `(function(){
    var rx=new RegExp(${JSON.stringify(reSrc)},'i');
    var els=Array.from(document.querySelectorAll('*')).filter(function(e){return e.offsetWidth>0 && e.children.length===0 && rx.test(e.textContent.trim());});
    if(!els.length)return null;
    var el=els[els.length-1];
    var r=el.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
  })()`);
  const pollCoords = async (reSrc, tries) => { for (let i=0;i<tries;i++){ const c=await coordsOf(reSrc); if(c)return c; await sleep(500); } return null; };

  // 1. click title button ([class*=nameButton]) center via DOM coords
  // Polling 等 title button DOM 渲染（冷启动场景下可能要 3-5s）
  let titleXY = null;
  for (let i = 0; i < 20; i++) {
    titleXY = await probe(client, `(function(){var el=document.querySelector('[data-name=pine-dialog] [class*=nameButton]')||document.querySelector('[class*=nameButton]');if(!el)return null;var r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    if (titleXY) break;
    await sleep(500);
  }
  if (!titleXY) { log('  WARN: title button not found after 10s polling, skip force-fresh'); return; }
  await click(titleXY.x, titleXY.y);

  // 2. 轮询等 "创建新的" 菜单出现（A2: 旧 sleep(1200) 在冷启动菜单渲染慢时漏点 → 整条 transient FATAL）
  //    多语言：创建新的 / Create New
  const cn = await pollCoords('^创建新的$|^Create New$', 16);   // 轮询 ~8s
  if (!cn) { log('  WARN: 创建新的 menu not found after 8s, skip force-fresh'); return; }
  await hover(cn.x, cn.y);

  // 3. 轮询等子菜单 "策略" 出现，再点（多语言：策略 / Strategy）
  const ce = await pollCoords('^策略$|^Strategy$', 10);        // 轮询 ~5s
  if (!ce) { log('  WARN: 策略 submenu not found, skip force-fresh'); return; }
  await click(ce.x, ce.y);
  await sleep(2000);

  // 4. 处理"当前脚本有未保存更改" → 点不保存/Don't save 创建新槽
  const dlg = await probe(client, `!!Array.from(document.querySelectorAll('[class*=popupDialog],[role=dialog]')).find(d=>d.offsetWidth>0 && /未保存的更改|未保存更改|您想保存|unsaved changes|Do you want to save/i.test(d.textContent))`);
  if (dlg) {
    const discardButton = findDiscardUnsavedChangesButtonExpression();
    const discardLabel = await probe(client, `(function(){
      var btn=${discardButton};
      if(!btn)return null;
      var label=(btn.textContent || btn.getAttribute('title') || btn.getAttribute('aria-label') || 'discard').trim();
      btn.click();
      return label;
    })()`);
    if (discardLabel) log(`  unsaved-changes confirm → click ${discardLabel} (discard)`);
    else log('  WARN: unsaved-changes confirm present but discard button not found');
    await sleep(3000);
  }
  const newTitle = await probe(client, `document.querySelector('[class*=nameButton]')?.textContent?.trim()`);
  log(`  new title: "${newTitle}"`);
}

async function ensureEditableEditor(client) {
  // 轮询：等横幅完全渲染（DOM 时序），最多 5s
  let isReadOnly = false;
  for (let i = 0; i < 10; i++) {
    isReadOnly = await probe(client, `Array.from(document.querySelectorAll('div')).some(d=>d.offsetWidth>0 && /此脚本为只读|This script is read-only/.test(d.textContent))`);
    if (isReadOnly) break;
    // 没检测到只读，但也可能编辑器还没加载完。再等等才放过
    await sleep(500);
    const editorReady = await probe(client, `document.querySelectorAll('.monaco-editor.pine-editor-monaco .view-line').length > 0`);
    if (editorReady && i >= 2) break; // 编辑器就绪且至少等了 1s
  }
  if (!isReadOnly) return false;
  // 先清掉 loadingScreen 遮罩——它会盖住只读横幅里的"制作副本"链接导致点不到
  await probe(client, `(function(){document.querySelectorAll('[class*=loadingScreen], [class*=loadingScreenShield]').forEach(e=>e.remove());})()`);
  await sleep(300);
  log('  editor is READ-ONLY → click "制作副本/创建工作副本" link');
  // 包含匹配"副本"，抗 TV 改字（创建工作副本 → 制作副本）。a 找不到再退到 button/span 点击
  const clicked = await probe(client, `(function(){
    var el = Array.from(document.querySelectorAll('a, button, [role=button], span.link-IcwlVZus, [class*=link-]')).find(function(x){
      return x.offsetWidth>0 && /副本|working copy|make a copy/i.test((x.textContent||'').trim()) && (x.textContent||'').trim().length<40;
    });
    if (el) { el.click(); return el.textContent.trim(); }
    return null;
  })()`);
  if (!clicked) {
    log('  WARN: read-only banner detected but 副本 link not found');
    return false;
  }
  log(`  clicked: "${clicked}"`);
  await sleep(3500);
  return true;
}

async function injectSource(client) {
  log('open Pine Editor');
  await ui.openPanel({panel:'pine-editor', action:'open'});
  await sleep(2500);
  await ensureEditableEditor(client);
  await forceFreshStrategySlot(client);
  log(`inject code (${code.split('\n').length} lines, tag=${tag})`);
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try { const r = await pine.setSource({source: code}); log(`  setSource ok: lines=${r.lines_set}`); return; }
    catch (e) {
      lastErr = e;
      log(`  retry setSource (${i+1}/6): ${e.message}`);
      // After 2 simple retries failed, try the "close panel + reopen" recovery (matches the manual workaround)
      if (i === 2) {
        log('  recovery: close Pine Editor panel + reopen');
        try { await ui.openPanel({panel:'pine-editor', action:'close'}); } catch(_){}
        await sleep(1500);
        try { await ui.openPanel({panel:'pine-editor', action:'open'}); } catch(_){}
        await sleep(3500);
      } else {
        await sleep(2500);
      }
    }
  }
  throw lastErr;
}

async function saveToLibrary(client) {
  // 用 Cmd+S 触发"保存脚本"对话框，命名为 "[AI] xxx"，避免留下悬空"无标题脚本"草稿
  const currentTitle = await probe(client, `document.querySelector('[class*=nameButton]')?.textContent?.trim()`);
  if (currentTitle && !/^无标题|^Untitled/i.test(currentTitle)) {
    log(`  already saved as "${currentTitle}", skip save`);
    return;
  }
  const saveName = flags.saveName || `[AI] ${scriptName}`;
  log(`Cmd+S → save to library as "${saveName}"`);
  await probe(client, `(function(){var t=document.querySelector('.monaco-editor.pine-editor-monaco textarea');if(t)t.focus();})()`);
  await client.Input.dispatchKeyEvent({type:'keyDown', modifiers:4, key:'s', code:'KeyS', windowsVirtualKeyCode:83});
  await client.Input.dispatchKeyEvent({type:'keyUp',   modifiers:4, key:'s', code:'KeyS', windowsVirtualKeyCode:83});
  await sleep(2500);
  // 处理"保存脚本"对话框
  const saveScriptDialog = findSaveScriptNamingDialogExpression();
  const hasDlg = await probe(client, `!!${saveScriptDialog}`);
  if (!hasDlg) { log('  WARN: save dialog did not appear'); return; }
  await probe(client, `(function(){
    var dlg=${saveScriptDialog};
    var input=dlg.querySelector('input');
    var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input, ${JSON.stringify(saveName)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await sleep(500);
  await probe(client, `(function(){
    var dlg=${saveScriptDialog};
    var btn=Array.from(dlg.querySelectorAll('button')).find(b=>['保存','Save'].includes(b.textContent.trim()));
    if (btn) btn.click();
  })()`);
  await sleep(3500);
  // 重名冲突对话框："脚本 'xxx' 已经存在。您真的要替换它吗？" → 点 是 覆盖
  const overwriteDlg = await probe(client, `!!Array.from(document.querySelectorAll('[class*=popupDialog],[role=dialog]')).find(d=>d.offsetWidth>0 && /已经存在.*替换|already exists.*replace/i.test(d.textContent))`);
  if (overwriteDlg) {
    log('  overwrite-confirm dialog → click 是');
    await probe(client, `(function(){
      var dlg=Array.from(document.querySelectorAll('[class*=popupDialog],[role=dialog]')).find(d=>d.offsetWidth>0 && /已经存在|already exists/i.test(d.textContent));
      var btn=Array.from(dlg.querySelectorAll('button')).find(b=>['是','Yes','Replace','替换'].includes(b.textContent.trim()));
      if (btn) btn.click();
    })()`);
    await sleep(3000);
  }
  const newTitle = await probe(client, `document.querySelector('[class*=nameButton]')?.textContent?.trim()`);
  log(`  title now: "${newTitle}"`);
}

async function classifyApplyError(client) {
  // B6: 分类 apply 后的错误。返回 null=无错误，否则 {type, detail}
  // type: readonly(只读模板) / syntax(Pine 编译错误) / server_reject(请求错误,通常覆盖冲突) / transient(加载失败/Failed to fetch)
  const banner = await probe(client, `(function(){
    var ro = Array.from(document.querySelectorAll('div')).some(function(d){return d.offsetWidth>0 && /此脚本为只读|This script is read-only/.test(d.textContent);});
    if (ro) return 'readonly';
    var txt = function(re){ return Array.from(document.querySelectorAll('div,span')).some(function(d){return d.offsetWidth>0 && d.children.length===0 && re.test(d.textContent) && d.textContent.length<200;}); };
    if (txt(/请求错误|Request error/)) return 'server_reject';
    if (txt(/加载失败|Failed to fetch|无法将.*添加/)) return 'transient';
    return null;
  })()`);
  if (!banner) return null;
  // Pine 编译错误优先级最高：查 Monaco error marker（有红波浪线则归 syntax，重试无用）
  const syntaxErrs = await probe(client, `(function(){
    try {
      var m = window.monaco;
      if (!m || !m.editor) return null;
      var models = m.editor.getModels();
      for (var i=0;i<models.length;i++){
        var mk = m.editor.getModelMarkers({resource: models[i].uri}).filter(function(x){return x.severity===8;});
        if (mk.length) return mk.slice(0,3).map(function(x){return 'L'+x.startLineNumber+': '+x.message;});
      }
    } catch(e){}
    return null;
  })()`);
  if (syntaxErrs && syntaxErrs.length) return {type:'syntax', detail: syntaxErrs};
  return {type: banner, detail: null};
}

async function applyToChart(client) {
  log('Cmd+Enter → apply to chart');
  await probe(client, `(function(){var t=document.querySelector('.monaco-editor.pine-editor-monaco textarea');if(t)t.focus();})()`);
  const clickedApply = await probe(client, `(function(){
    var b=${findPineApplyButtonExpression()};
    if (!b) return null;
    var label = b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent.trim() || 'Pine Apply';
    b.click();
    return label;
  })()`);
  if (clickedApply) log(`  click Pine apply button: ${clickedApply}`);
  else {
    await client.Input.dispatchKeyEvent({type:'keyDown', modifiers:4, key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
    await client.Input.dispatchKeyEvent({type:'keyUp',   modifiers:4, key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
  }
  await sleep(3500);
  // B6: 分类错误，返回给上层决定是否自愈重试（不再直接 FATAL）
  const err = await classifyApplyError(client);
  if (err) { log(`  apply error: ${err.type}${err.detail ? ' — ' + JSON.stringify(err.detail) : ''}`); return {ok:false, ...err}; }
  // 等 Strategy 真正应用到图表（Pine 编译完成 + Strategy Tester 有内容）
  log('  waiting for strategy to actually apply...');
  const applied = await waitForStrategyApplied(client);
  if (!applied) log('  note: Strategy Tester readiness timeout; will verify chart study before reading metrics');

  // 场景 A: "无法将未保存更改的脚本添加到图表中" → 保存/保存并添加到图表
  if (await probe(client, `!!Array.from(document.querySelectorAll('[class*=popupDialog],[role=dialog]')).find(d=>d.offsetWidth>0 && (d.textContent.includes('未保存') || /unsaved/i.test(d.textContent)))`)) {
    const saveBeforeAddButton = findSaveBeforeAddButtonExpression();
    const saveBeforeAddLabel = await probe(client, `(function(){
      var btn=${saveBeforeAddButton};
      if(!btn)return null;
      var label=(btn.textContent || btn.getAttribute('title') || btn.getAttribute('aria-label') || 'save').trim();
      btn.click();
      return label;
    })()`);
    if (!saveBeforeAddLabel) {
      log('  apply blocked: save-before-add dialog present but save button not found');
      return {ok:false, type:'save_before_add_blocked', detail:null};
    }
    log(`  scenario: save-before-add dialog → click ${saveBeforeAddLabel}`);
    await sleep(4500);
  }

  // 场景 B: "保存脚本" 命名对话框 (全新脚本首次应用)
  const saveScriptDialog = findSaveScriptNamingDialogExpression();
  if (await probe(client, `!!${saveScriptDialog}`)) {
    log(`  scenario: save-script naming → "${scriptName}"`);
    await probe(client, `(function(){
      var dlg=${saveScriptDialog};
      var input=dlg.querySelector('input');
      var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(input, ${JSON.stringify(scriptName)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await sleep(500);
    await probe(client, `(function(){
      var dlg=${saveScriptDialog};
      var btn=Array.from(dlg.querySelectorAll('button')).find(b=>['保存','Save'].includes(b.textContent.trim()));
      btn.click();
    })()`);
    await sleep(5500);
  }
  // 场景 C: 同名直接更新 (无对话框) → 不需额外操作
  return {ok:true};
}

async function waitForStrategyApplied(client, maxMs=12000) {
  // 等 Strategy Tester 实际有内容（不再是"要测试策略，请将其应用于图表"提示）
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const ready = await probe(client, `(function(){
      var noStrategy = Array.from(document.querySelectorAll('div')).some(d=>d.offsetWidth>0 && /要测试策略|请将其应用|test a strategy/i.test(d.textContent)); // 英文 best-effort，未经英文 UI 实跑验证
      var hasDropdown = !!document.querySelector('button[class*=dropdownBtn]');
      var pineEditorLoading = !!document.querySelector('.monaco-editor.pine-editor-monaco') && document.querySelectorAll('.monaco-editor.pine-editor-monaco .view-line').length === 0;
      return !noStrategy && hasDropdown && !pineEditorLoading;
    })()`);
    if (ready) return true;
    await sleep(800);
  }
  return false;
}

async function showStrategyTester(client) {
  log('open Strategy Tester (programmatic)');
  // 通过 TV 内部 API 强制激活 backtesting widget 并展开
  await probe(client, `(function(){
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (!bwb) return 'no_bwb';
    if (bwb.showWidget) bwb.showWidget('backtesting');
    if (bwb.activateWidget) bwb.activateWidget('backtesting');
    if (bwb.setMode) bwb.setMode('normal');
    return 'ok';
  })()`);
  await sleep(2500);
  await dismissOnboarding(client); // 关掉 TV 改版引导浮层，否则挡住 sub-tab 交互
  // 切到底部最下方的"指标"汇总 tab (不是顶部 indicator 市场按钮)
  await probe(client, `(function(){
    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    var root = (bwb && bwb._container) || document;
    var btns = Array.from(root.querySelectorAll('button')).filter(function(b){var t=b.textContent.trim(); return b.offsetWidth>0 && (t==='指标' || t==='Indicators');}); // 英文候选 best-effort，未经英文 UI 实跑验证
    var sorted = btns.map(b=>({b, y: b.getBoundingClientRect().top})).sort((a,b)=>b.y-a.y);
    if (sorted.length && sorted[0].y > 0) sorted[0].b.click();
  })()`);
  await sleep(1500);
  // 注：切换到目标 strategy + 回验交给 selectTargetStrategy（在 collectRun 里 readMetrics 之前调用）。
  // 旧的 button[class*=dropdownBtn] 选择器 TV 已废弃（失效后 no_dropdown），不再依赖易变 class。
}

async function readCurrentStrategyName(client) {
  // Strategy Tester selector 当前显示的策略名。反查图上 study 名匹配可见 button 文本，
  // 不依赖易变的 hash class（dropdownBtn 已被 TV 废弃）。下拉关闭时只有"当前选中"名可见。
  return await probe(client, `(function(){
    var w = window.TradingViewApi._activeChartWidgetWV.value();
    var names = (w.getAllStudies()||[]).map(function(s){return s.name;});
    var btns = Array.from(document.querySelectorAll('button')).filter(function(b){return b.offsetWidth>0;});
    for (var i=0;i<btns.length;i++){ var t=btns[i].textContent.trim(); if(names.indexOf(t)>=0) return t; }
    return null;
  })()`);
}

async function resolveCurrentStrategyName(client) {
  const visibleName = await readCurrentStrategyName(client);
  if (visibleName) return visibleName;
  const inventory = await data.getStrategyInventory();
  return inventory.count === 1 ? inventory.strategies[0]?.name || null : null;
}

async function listChartStrategies(client) {
  // 图上 strategy 类 study 名（pineFeatures 含 strategy；内置指标如 Volume 无此 input → 排除）。
  // 局限：仅识别 pine 脚本策略；TV 内置策略（如 MACD Strategy）无 pineFeatures，残留警告可能漏报。
  // 但读数正确性不依赖此——回验靠 readCurrentStrategyName 反查全部 study 名（含内置），故仍安全。
  return await probe(client, `(function(){
    var w = window.TradingViewApi._activeChartWidgetWV.value();
    var all = w.getAllStudies()||[]; var res=[];
    for (var i=0;i<all.length;i++){
      try{ var f=w.getStudyById(all[i].id); var iv=(f.getInputValues&&f.getInputValues())||[];
        var pf=iv.filter(function(x){return x.id==='pineFeatures';})[0];
        if(pf && /strategy/i.test(String(pf.value))) res.push(all[i].name);
      }catch(e){}
    }
    return res;
  })()`);
}

async function selectTargetStrategy(client) {
  // 🔑 读数闸门：确保 Strategy Tester 当前显示的就是目标策略，否则切换+回验。
  // 多 strategy 残留时，避免读到别的策略的回测（曾导致 MACD 的 +8.85% 被误当成本策略结果）。
  const strategies = (await listChartStrategies(client)) || [];
  const others = strategies.filter(n => n !== scriptName);
  if (others.length) log(`  ⚠️ 图上还有 ${others.length} 个别的策略: [${others.join(', ')}] —— 已确保读取目标，但建议在 TV 上清理以免肉眼核对时混淆`);

  let current = await resolveCurrentStrategyName(client);
  if (current === scriptName) { log(`  Strategy Tester 选中策略: "${current}" ✓`); return true; }

  log(`  Strategy Tester 当前显示 "${current || '?'}" ≠ 目标，切换到 "${scriptName}"`);
  await probe(client, `(function(){
    var w = window.TradingViewApi._activeChartWidgetWV.value();
    var names = (w.getAllStudies()||[]).map(function(s){return s.name;});
    var btns = Array.from(document.querySelectorAll('button')).filter(function(b){return b.offsetWidth>0 && names.indexOf(b.textContent.trim())>=0;});
    if (btns.length) btns[0].click();
    return btns.length;
  })()`);
  await sleep(900);
  const picked = await probe(client, `(function(){
    var items = Array.from(document.querySelectorAll('[role=menuitem], [class*=dropdownItem], [class*=item-], li, [class*=Item]')).filter(function(e){return e.offsetWidth>0 && e.textContent.indexOf(${JSON.stringify(scriptName)})>=0 && e.textContent.length<200;});
    if(!items.length) return 'no_match';
    items.sort(function(a,b){return a.textContent.length-b.textContent.length;});
    items[0].click(); return 'clicked';
  })()`);
  log(`  dropdown pick: ${picked}`);
  await sleep(3000);

  current = await resolveCurrentStrategyName(client);
  const ok = current === scriptName;
  if (!ok) log(`  ✗ 切换后当前仍是 "${current || 'null'}"，未能选中目标策略`);
  return ok;
}

async function readMetrics(client) {
  // 优先走 MCP 的 data.getStrategyResults：TV 内部 dataSources()._chartWidget API，
  // 字段更全（自动含 B&H benchmark 等），不依赖中文 label。失败时 fallback 到 DOM 抓取。
  try {
    const r = await data.getStrategyResults({ strategy_name: scriptName });
    if (r?.success && r?.core_complete) {
      log(`  metrics via internal API: ${r.metric_count} fields`);
      return r.metrics;
    }
    log(`  internal API returned incomplete/error (${r?.error || `${r?.metric_count || 0} compact fields`}), fallback to DOM`);
  } catch (e) {
    log(`  internal API threw (${e.message}), fallback to DOM`);
  }
  const domMetrics = await readMetricsViaDom(client);
  if (!hasCoreStrategyMetrics(domMetrics)) {
    throw new Error('STRATEGY_METRICS_INCOMPLETE: internal API and DOM fallback did not provide the core Strategy Tester KPIs');
  }
  return domMetrics;
}

async function readStrategyTesterRangeTexts(client) {
  return await probe(client, `(function(){
    var root = document.querySelector('.bottom-widgetbar-content.backtesting')
      || document.querySelector('[class*="backtestingReport"]')
      || document.querySelector('[data-name="backtesting"]')
      || document.querySelector('[class*="strategyReport"]');
    if (!root) return [];
    var seen = {}; var out = [];
    var nodes = Array.from(root.querySelectorAll('button,[role="button"],span,div'));
    for (var i = 0; i < nodes.length && out.length < 6; i++) {
      var node = nodes[i];
      if (!node.offsetWidth || !node.offsetHeight) continue;
      var text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text.length < 12 || text.length > 80) continue;
      var years = text.match(/(?:19|20)\\d{2}/g) || [];
      if (years.length !== 2 || seen[text]) continue;
      seen[text] = true; out.push(text);
    }
    return out;
  })()`);
}

async function captureEvaluationRange(client) {
  try {
    const internal = await data.getStrategyRangeCandidate({ strategy_name: scriptName });
    const exact = rangeFromAllowlistedReport(internal?.range_candidate);
    if (exact) return exact;
  } catch (e) {
    log(`  range evidence internal unavailable: ${e.message}`);
  }
  try {
    const texts = await readStrategyTesterRangeTexts(client);
    for (const text of texts || []) {
      const exact = parseRangeText(text);
      if (exact) return exact;
    }
  } catch (e) {
    log(`  range evidence toolbar unavailable: ${e.message}`);
  }
  try {
    const series = await chart.getSeriesTimeRange();
    return rangeFromChartSeries(series);
  } catch (e) {
    log(`  range evidence chart proxy unavailable: ${e.message}`);
    return null;
  }
}

function buildEvaluationEvidence({ symbol, timeframe, range, bhPct, benchmarkSource }) {
  const context = {
    symbol: symbol || null,
    timeframe: timeframe || null,
    costs: costPatch.costs || null,
    sourceDigest: strategyDigest,
    requestedRange: { mode: 'full_history' },
  };
  const normalizedContext = normalizeContext(context);
  const normalizedRange = normalizeRange(range);
  return {
    context,
    contextKey: normalizedContext.contextKey,
    range: normalizedRange,
    rangeKey: normalizedRange ? JSON.stringify(normalizedRange) : null,
    bhPct: Number.isFinite(Number(bhPct)) ? Number(bhPct) : null,
    benchmarkSource: benchmarkSource || null,
  };
}

async function readMetricsViaDom(client) {
  const metrics = await probe(client, `(function(){
    // Strategy Tester 顶部 KPI 卡片：label 上方/旁边显示数值（与表格结构不同）
    function findKpi(label) {
      var lbls = Array.from(document.querySelectorAll('div,span')).filter(d=>d.offsetWidth>0 && d.textContent.trim()===label && d.children.length===0);
      for (var lbl of lbls) {
        var p = lbl.parentElement;
        for (var depth=0; depth<5 && p; depth++) {
          var cands = Array.from(p.querySelectorAll('div,span')).filter(e=>{
            if (e.children.length>0 || e === lbl) return false;
            var t = (e.textContent || '').trim();
            // 排除 'undefined' 字面量、空文本、label 本身
            if (!t || t === 'undefined' || t === label) return false;
            return t.length<60 && /\\d/.test(t);
          });
          if (cands.length) return cands.slice(0,2).map(e=>(e.textContent||'').trim()).join(' | ');
          p = p.parentElement;
        }
      }
      return null;
    }
    // 表格行 (TR)：第一个 TD 是标签，后续 TD 是 All/Long/Short 三列数值
    function findRow(label) {
      var rows = Array.from(document.querySelectorAll('tr.ka-tr, tr[class*=tableRow]')).filter(r=>r.offsetWidth>0);
      for (var r of rows) {
        var cells = Array.from(r.querySelectorAll('td'));
        if (!cells.length) continue;
        if (cells[0].textContent.trim() === label) {
          return cells.slice(1).map(c=>c.textContent.trim()).filter(Boolean)[0] || null;
        }
      }
      return null;
    }
    // 卡片网格 (Overview tab)：每张 containerCell = [label, value, 单位?, pct?]
    // 返回 label 之后的值数组（剔除 USD / 纯单位），找不到返回 null
    function cardVals(label) {
      var cells = Array.from(document.querySelectorAll('[class*=containerCell-]')).filter(function(e){return e.offsetWidth>0;});
      for (var i=0;i<cells.length;i++) {
        var texts = Array.from(cells[i].querySelectorAll('*')).filter(function(e){return e.children.length===0 && e.textContent.trim();}).map(function(e){return e.textContent.trim();});
        if (texts[0] === label) {
          return texts.slice(1).filter(function(t){return !/^(USD|CNY|HKD|EUR|JPY|GBP|AUD|CAD|CHF|SGD|TWD|KRW)$/.test(t);});
        }
      }
      return null;
    }
    function cardJoin(label) { var v = cardVals(label); return v && v.length ? v.join(' | ') : null; }
    var reportRoot = document.querySelector('.bottom-widgetbar-content.backtesting')
      || document.querySelector('[class*="backtestingReport"]')
      || document.querySelector('[data-name="backtesting"]')
      || document.querySelector('[class*="strategyReport"]');
    var reportText = reportRoot ? reportRoot.textContent || '' : '';
    return {
      __no_trade: /本报告需要交易数据|report requires trade data|after the script executes a trade/i.test(reportText),
      total_pnl:       cardJoin('Total PnL') || cardJoin('总损益') || cardJoin('总盈亏') || cardJoin('净利润') || findKpi('总损益') || findKpi('总盈亏') || findKpi('净利润') || findKpi('Total PnL') || findKpi('Net profit'),
      max_drawdown:    cardJoin('Max drawdown') || cardJoin('最大股权回撤') || cardJoin('最大回撤') || findKpi('最大股权回撤') || findKpi('最大回撤') || findKpi('Max drawdown') || findKpi('Max equity drawdown'),
      total_trades:    (function(){ var w=cardVals('盈利交易')||cardVals('Winning trades')||cardVals('Profitable trades'); var s=w&&w.find(function(x){return x.indexOf('/')!==-1;}); if(s)return s.split('/')[1]; return findKpi('总交易')||findRow('总交易')||findKpi('Total trades')||findRow('Total trades'); })(),
      profit_factor:   (function(){ var v=cardVals('盈利因子')||cardVals('Profit factor'); if(v&&v.length)return v[0]; return findKpi('获利因子')||findRow('获利因子')||findRow('盈利因子')||findKpi('Profit factor')||findRow('Profit factor'); })(),
      win_pct:         (function(){ var w=cardVals('盈利交易')||cardVals('Winning trades')||cardVals('Profitable trades'); var p=w&&w.find(function(x){return x.indexOf('%')!==-1;}); if(p)return p; return findKpi('获利率')||findKpi('获利百分比')||findRow('获利百分比')||findKpi('Percent profitable')||findKpi('Win rate'); })(),
      avg_win_loss:    cardJoin('平均胜率/平均负率') || cardJoin('Avg win/loss') || findRow('平均胜率/平均负率') || findRow('平均胜率 / 平均负率') || findRow('Avg win/loss') || findRow('Average win/loss'),
      // A2: B&H benchmark — label 是"买入和持有的损益"（dump 确认），但默认 tab 该 label
      // 邻近数字是图表 Y 轴刻度（"0.00 | 25.00 K" 形式），不是真实 B&H 值。
      // 真实值在"基准比较"子 tab，需 navigate 才能拿到（后续 fix）。这里加过滤排除明显刻度格式。
      buy_hold_return: (function(){
        var v = findKpi('买入和持有的损益') || findRow('买入和持有的损益') || findKpi('Buy & Hold Return') || findKpi('Buy and hold PnL') || findRow('Buy and hold PnL');
        if (v && /\\s[KMB]\\b/.test(v.replace(/[\\u2066\\u2067\\u2068\\u2069\\u202a-\\u202e]/g,''))) return null;
        return v;
      })(),
      winning_trades:  (function(){ var w=cardVals('盈利交易')||cardVals('Winning trades')||cardVals('Profitable trades'); if(w&&w.length)return w.join(' | '); return findKpi('盈利交易')||findRow('盈利交易')||findKpi('Winning trades')||findRow('Winning trades'); })(),
    };
  })()`);
  const noTrade = metrics?.__no_trade === true;
  if (metrics && '__no_trade' in metrics) delete metrics.__no_trade;
  return normalizeNoTradeMetrics(metrics, noTrade);
}

async function waitForStrategyReportReady(client, timeoutMs = 45000) {
  const startedAt = Date.now();
  let stableReady = 0;
  let stableInternalReady = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const state = await probe(client, `(function(){
      var root = document.querySelector('.bottom-widgetbar-content.backtesting')
        || document.querySelector('[class*="backtestingReport"]')
        || document.querySelector('[data-name="backtesting"]')
        || document.querySelector('[class*="strategyReport"]');
      if (!root) return { panel: false, updating: false, terminal: false };
      var visibleText = Array.from(document.querySelectorAll('div,span')).filter(function(el){
        return el.offsetWidth > 0 && el.offsetHeight > 0 && el.children.length === 0;
      }).map(function(el){ return (el.textContent || '').trim(); }).filter(Boolean);
      var updating = visibleText.some(function(text){
        return /正在更新报告|正在计算|Updating report|Calculating/i.test(text);
      });
      var text = root.textContent || '';
      var hasKpi = /总损益|总盈亏|净利润|Total PnL|Net profit/i.test(text);
      var noTrade = /本报告需要交易数据|report requires trade data|after the script executes a trade/i.test(text);
      return { panel: true, updating: updating, terminal: hasKpi || noTrade };
    })()`);
    if (state?.panel && !state.updating && state.terminal) {
      stableReady++;
      if (stableReady >= 2) return state;
    } else {
      stableReady = 0;
    }

    if (!state?.updating) {
      try {
        const internal = await data.getStrategyResults({ strategy_name: scriptName });
        if (internal?.core_complete) {
          stableInternalReady++;
          if (stableInternalReady >= 2) return { ...state, terminal: true, source: 'internal_api' };
        } else {
          stableInternalReady = 0;
        }
      } catch {
        stableInternalReady = 0;
      }
    } else {
      stableInternalReady = 0;
    }
    await sleep(1000);
  }
  throw new Error(`REPORT_RECALC_TIMEOUT after ${timeoutMs}ms`);
}

async function navigateBenchmarkTab(client) {
  // A2.1: 找 Strategy Tester 的 Benchmarking sub-tab (role=tab, text="Benchmarking" 或 "基准比较") 并点击
  return await probe(client, `(function(){
    var tabs = Array.from(document.querySelectorAll('[role=tab]')).filter(function(t){return t.offsetWidth>0;});
    var bm = tabs.find(function(t){var x = t.textContent.trim(); return x.length<20 && /^基准|benchmark/i.test(x);}); // 抗改名: 基准比较→基准；英文 "Benchmarking"=12 字符，放宽到 <20
    if (!bm) return {found: false};
    bm.click();
    return {found: true, label: bm.textContent.trim()};
  })()`);
}

async function navigateTradeAnalysisTab(client) {
  // polish: 切到 "交易分析详情 / Trade analysis" sub-tab，让 Average profit/loss ratio 等详细 row 可见
  return await probe(client, `(function(){
    var tabs = Array.from(document.querySelectorAll('[role=tab]')).filter(function(t){return t.offsetWidth>0;});
    var ta = tabs.find(function(t){var x = t.textContent.trim(); return /^交易分析|^trades?\\s+analysis/i.test(x);}); // 英文实为 "Trades analysis details"，用前缀正则容错（\\s 双写：probe 模板字符串会吃掉单 \\s）
    if (!ta) return {found: false};
    ta.click();
    return {found: true, label: ta.textContent.trim()};
  })()`);
}

async function readAvgWinLoss(client) {
  // polish: navigate 交易分析详情 后用 findRow 抓 "Average profit / average loss" row 值
  return await probe(client, `(function(){
    var rows = Array.from(document.querySelectorAll('tr.ka-tr, tr[class*=tableRow]')).filter(function(r){return r.offsetWidth>0;});
    var cands = ['平均盈利/平均亏损','平均盈利 / 平均亏损','Average profit / average loss','平均利润/平均亏损','平均利润 / 平均亏损','平均胜率/平均负率','平均胜率 / 平均负率','Avg win/loss','Average win/loss'];
    for (var i=0;i<rows.length;i++) {
      var cells = Array.from(rows[i].querySelectorAll('td'));
      if (!cells.length) continue;
      var label = cells[0].textContent.trim();
      if (cands.indexOf(label) !== -1) {
        var vals = cells.slice(1).map(function(c){return c.textContent.trim();}).filter(Boolean);
        return vals[0] || null;
      }
    }
    return null;
  })()`);
}

async function navigateOverviewTab(client) {
  // 确保 readMetrics 之前 Strategy Tester 在 Overview tab（主 KPI 卡片只在 Overview 上显示）
  return await probe(client, `(function(){
    var tabs = Array.from(document.querySelectorAll('[role=tab]')).filter(function(t){return t.offsetWidth>0;});
    var ov = tabs.find(function(t){var x = t.textContent.trim(); return x === 'Overview' || x === '概览' || x === '概述';});
    if (!ov) return {found: false};
    ov.click();
    return {found: true, label: ov.textContent.trim()};
  })()`);
}

async function readBenchmarkBH(client) {
  // A2.1: navigate 后抓 Buy and hold / Strategy 在该 sub-tab 上的真实 KPI 值
  return await probe(client, `(function(){
    function findKpi(label) {
      var lbls = Array.from(document.querySelectorAll('div,span')).filter(function(d){return d.offsetWidth>0 && d.textContent.trim()===label && d.children.length===0;});
      for (var i=0;i<lbls.length;i++) {
        var lbl = lbls[i];
        var p = lbl.parentElement;
        for (var depth=0; depth<5 && p; depth++) {
          var cands = Array.from(p.querySelectorAll('div,span')).filter(function(e){
            if (e.children.length>0 || e === lbl) return false;
            var t = (e.textContent || '').trim();
            if (!t || t === 'undefined' || t === label) return false;
            return t.length<60 && /\\d/.test(t);
          });
          if (cands.length) return cands.slice(0,2).map(function(e){return (e.textContent||'').trim();}).join(' | ');
          p = p.parentElement;
        }
      }
      return null;
    }
    // 包含/正则匹配版：抗 TV 改 label（如"买入和持有的损益"→"买入和持有损益"，少了"的"）
    function findKpiLike(re) {
      var lbls = Array.from(document.querySelectorAll('div,span')).filter(function(d){return d.offsetWidth>0 && d.children.length===0 && re.test((d.textContent||'').trim());});
      for (var i=0;i<lbls.length;i++) {
        var lbl = lbls[i], lt = (lbl.textContent||'').trim(), p = lbl.parentElement;
        for (var depth=0; depth<5 && p; depth++) {
          var cands = Array.from(p.querySelectorAll('div,span')).filter(function(e){
            if (e.children.length>0 || e === lbl) return false;
            var t = (e.textContent || '').trim();
            if (!t || t === 'undefined' || t === lt) return false;
            return t.length<60 && /\\d/.test(t);
          });
          if (cands.length) return cands.slice(0,2).map(function(e){return (e.textContent||'').trim();}).join(' | ');
          p = p.parentElement;
        }
      }
      return null;
    }
    return {
      bh_return:       findKpiLike(/^买入和持有.*损益$/) || findKpiLike(/^Buy and hold PnL$/i) || findKpi('买入和持有的损益') || findKpiLike(/^买入和持有$/),
      strategy_return: findKpiLike(/^策略.*损益$/)       || findKpiLike(/^Strategy PnL$/i)     || findKpi('策略损益'),
    };
  })()`);
}

async function dumpKpiLabels(client) {
  // 诊断: 扫所有 Strategy Tester 顶部 KPI 卡里的 label 文本（含数字旁边的标签），
  // 用于校正 readMetricsViaDom 的候选 label 列表。返回去重后的 label 列表。
  return await probe(client, `(function(){
    var labels = new Set();
    // 顶部 KPI: 找到所有"含数字邻居"的纯文本叶子节点附近的 label
    var nodes = Array.from(document.querySelectorAll('div,span')).filter(function(d){
      return d.offsetWidth>0 && d.children.length===0 && d.textContent.trim().length>0 && d.textContent.trim().length<30;
    });
    // 启发式: 一个 label 节点周围 50px 内有含数字的兄弟/叔伯节点
    var BACKTEST_PANEL = document.querySelector('.bottom-widgetbar-content.backtesting') || document.querySelector('[class*="backtestingReport"]') || document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
    var inPanel = function(el){ return !BACKTEST_PANEL || BACKTEST_PANEL.contains(el); };
    nodes.forEach(function(n){
      if (!inPanel(n)) return;
      var t = n.textContent.trim();
      if (/^[\\d\\-\\+\\.,%\\s\\|x]+$/.test(t)) return; // 跳过纯数字
      // 只跳过明确的"详细统计表格"行（findRow 已覆盖），不过滤通用 td（KPI 卡片可能也在 td 内）
      if (n.closest('tr.ka-tr, tr[class*=tableRow]')) return;
      labels.add(t);
    });
    return Array.from(labels).slice(0, 200);
  })()`);
}

async function clearStuckLoadingOverlay(client) {
  // TV UI bug：Pine 编辑器的 loadingScreen 遮罩在内容已就绪后仍 visible，挡住编辑器。
  // 直接移除 DOM 元素（含其下的 shield 层），不会影响实际数据，只是清理 UI。
  const removed = await probe(client, `(function(){
    var els = document.querySelectorAll('[class*=loadingScreen], [class*=loadingScreenShield]');
    els.forEach(e=>e.remove());
    return els.length;
  })()`);
  if (removed > 0) log(`  cleared ${removed} stuck loading overlay element(s)`);
}

async function snapshot(client, path) {
  const s = await client.Page.captureScreenshot({format:'png'});
  writeFileSync(path, Buffer.from(s.data, 'base64'));
}

async function prepareProofScreenshot(client) {
  try { await ui.openPanel({panel:'pine-editor', action:'close'}); } catch {}
  await probe(client, `(function(){
    var root = document.querySelector('[data-name="pine-dialog"]');
    if (!root) return false;
    var close = root.querySelector('[aria-label="关闭"]') || root.querySelector('[aria-label="Close"]') || root.querySelector('[title="关闭"]') || root.querySelector('[title="Close"]');
    if (!close) return false;
    close.click(); return true;
  })()`);
  await sleep(500);
  try { await ui.openPanel({panel:'alerts', action:'close'}); } catch {}
  await sleep(300);
  await showStrategyTester(client);
  await selectTargetStrategy(client);
  const overview = await navigateOverviewTab(client);
  await waitForStrategyReportReady(client);
  if (overview?.found) await sleep(1200);
  await probe(client, `(function(){
    var root = document.querySelector('.bottom-widgetbar-content.backtesting') || document.querySelector('[class*="backtestingReport"]');
    if (!root) return 0;
    var scrollables = Array.from(root.querySelectorAll('*')).filter(function(e){return e.scrollHeight > e.clientHeight + 20 && e.clientHeight > 100;});
    scrollables.forEach(function(e){ e.scrollTop = 0; });
    return scrollables.length;
  })()`);
  await sleep(500);
}

async function verifyLiveProofContext(client, expectedParams = proofExpectedParams) {
  currentStage = 'proof_context';
  const state = await chart.getState();
  const actual = {
    symbol: state.symbol || null,
    strategyName: await resolveCurrentStrategyName(client),
    params: lastAppliedInputs,
  };
  const expected = { symbol: primarySymbol, strategyName: scriptName, params: expectedParams || {} };
  const result = verifyProofContext({ expected, actual });
  runManifest.proof = result;
  writeRunManifest();
  if (!result.ok) throw new Error(`proof context mismatch: ${JSON.stringify(result.mismatches)}`);
  completeStage(runManifest, 'proof_context', { evidence: actual });
  writeRunManifest();
  return result;
}

async function captureProof(client, expectedParams = proofExpectedParams) {
  await prepareProofScreenshot(client);
  await verifyLiveProofContext(client, expectedParams);
  await snapshot(client, PROOF_PNG);
  completeStage(runManifest, 'proof_screenshot', {
    evidence: { symbol: primarySymbol, strategyName: scriptName },
    artifacts: { proofScreenshot: PROOF_PNG },
  });
  writeRunManifest();
}

async function injectAndApply(client) {
  // polish-2 + B6: 注入 + 应用，遇可恢复错误自愈重试（冷启动 title button 未就绪 / server 拒收 / 只读模板）
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await injectSource(client); // 内部已含 ensureEditableEditor + forceFreshStrategySlot + setSource 重试
    const r = await applyToChart(client);
    if (r.ok) {
      // 🔑 applyToChart 只查错误 banner，不保证策略真落到图上。这里轮询确认（最多 8s），
      //    否则会出现"没报错但策略没应用 → 后续读到残留数据"的假成功。
      let onChart = false;
      for (let i = 0; i < 8; i++) { if (await verifyStrategyOnChart(client)) { onChart = true; break; } await sleep(1000); }
      if (onChart) { log(`  ✓ 策略已确认在图表上`); return; }
      log(`  apply 返回 ok 但图上仍无 "${scriptName}" study → 判为未应用，重试 ${attempt}/3`);
      last = { type: 'not_applied' };
      await dismissModalIfAny(client);
      continue;
    }
    last = r;
    if (r.type === 'syntax') throw new Error(`Pine 编译错误（重试无用）: ${JSON.stringify(r.detail)}`);
    log(`  recovery ${attempt}/3 for "${r.type}" — dismiss modal + re-inject`);
    if (r.type === 'transient') await sleep(4000);
    await dismissModalIfAny(client); // 清掉错误弹窗/banner，下一轮 injectSource 会重开新槽
  }
  throw new Error(`apply failed after 3 attempts (last: ${last?.type}) — 策略未能应用到图表，已避免返回假数据`);
}

async function injectOrReuse(client) {
  currentStage = 'strategy_apply';
  // --reuse 只复用本地记录中同名且源码摘要一致的策略。摘要缺失或变化时安全降级为重新注入。
  if (flags.reuse) {
    let record = null;
    try { record = JSON.parse(readFileSync(LAST_STUDY_META_FILE, 'utf8')); } catch {}
    const reuseCheck = evaluateReuse(record, scriptName, costPatch.code);
    if (!reuseCheck.ok) {
      log(`  --reuse disabled: ${reuseCheck.reason}，改为重新注入`);
    } else if (await verifyStrategyOnChart(client)) {
      log(`  --reuse: 图上已有 "${scriptName}" 且源码摘要一致，跳过注入，直接改参数`);
      completeStage(runManifest, 'strategy_apply', { evidence: { reused: true, strategyName: scriptName, reuseCheck: reuseCheck.reason } });
      writeRunManifest();
      return;
    }
  }
  await preCleanStudies(client);
  await injectAndApply(client);
  await saveToLibrary(client);
  completeStage(runManifest, 'strategy_apply', { evidence: { reused: false, strategyName: scriptName } });
  writeRunManifest();
}

async function switchSymbol(sym) {
  if (!sym) return;
  log(`switch symbol → ${sym}`);
  try { const r = await chart.setSymbol({ symbol: sym }); log(`  ok (chart_ready=${r.chart_ready})`); }
  catch (e) { log(`  WARN: setSymbol failed: ${e.message}`); }
  await sleep(2500); // 等 strategy 在新 symbol 上重算
}

async function setTimeframeIfRequested() {
  if (!flags.timeframe) return;
  log(`set timeframe: ${flags.timeframe}`);
  try { const r = await chart.setTimeframe({ timeframe: flags.timeframe }); log(`  ok (chart_ready=${r.chart_ready})`); }
  catch (e) { log(`  WARN: setTimeframe failed: ${e.message}`); }
}

async function verifyDeclaredSourceInputs(client) {
  if (!Object.keys(flags.sourceInputs).length) {
    verifiedSourceInputs = {};
    lastAppliedInputs = {};
    return {};
  }
  const state = await chart.getState();
  const target = (state.studies || []).find(study => study.name === scriptName);
  if (!target) throw new Error(`SOURCE_INPUT_MISMATCH: strategy not found: ${scriptName}`);
  const live = await data.getIndicator({ entity_id: target.id });
  verifiedSourceInputs = verifySourceInputValues({
    pineSource: rawCode,
    expected: flags.sourceInputs,
    actualInputs: live.inputs,
  });
  lastAppliedInputs = { ...verifiedSourceInputs };
  completeStage(runManifest, 'source_inputs', { evidence: { params: verifiedSourceInputs } });
  writeRunManifest();
  return verifiedSourceInputs;
}

async function applyStrategyInputs(client, inputsOverride) {
  // B5: 通过 indicators.setInputs 改 strategy 运行时参数（不污染源码）
  const inputs = inputsOverride || flags.inputs;
  if (!Object.keys(inputs).length) {
    lastAppliedInputs = mergeProvenInputs(verifiedSourceInputs, inputs);
    return;
  }
  const state = await chart.getState();
  const studies = state.studies || [];
  if (!studies.length) { log('  WARN: no studies on chart, skip applyStrategyInputs'); return; }
  // 优先按名字定位本策略（reuse 下图上可能有别的 study，不能盲取最后一个）；找不到退到最后一个
  const target = studies.find(s => s.name === scriptName) || studies[studies.length - 1];
  log(`apply inputs to "${target.name}" (${target.id})`);

  // title → in_N 映射，用户可用 friendly name（如 "Oversold"）或直接 in_N
  const titleMap = buildInputTitleMap(rawCode);
  const remapped = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (/^in_\d+$/.test(k)) { remapped[k] = v; }
    else if (titleMap[k]) {
      log(`  remap "${k}" → ${titleMap[k]} = ${v}`);
      remapped[titleMap[k]] = v;
    } else {
      log(`  WARN: input "${k}" not found in title map, passing as-is`);
      remapped[k] = v;
    }
  }
  try {
    const r = await indicators.setInputs({ entity_id: target.id, inputs: remapped });
    log(`  updated (${r.input_source || 'study_api'}): ${JSON.stringify(r.updated_inputs)}`);
    const unmatched = Object.keys(remapped).filter(k => !(k in (r.updated_inputs || {})));
    if (unmatched.length) throw new Error(`INPUT_UPDATE_MISMATCH: ${unmatched.join(', ')}`);
    if (!unmatched.length) lastAppliedInputs = mergeProvenInputs(verifiedSourceInputs, inputs);
  } catch (e) {
    throw new Error(`setInputs failed: ${e.message}`);
  }
  await sleep(3000); // 等 strategy 重算
}

let _dumpedKpi = false;
async function verifyStrategyOnChart(client) {
  // 🔑 信任闸门：确认图表上真有名为 scriptName 的 strategy study。
  // 没有 = 策略根本没应用上，此时读到的 Strategy Tester 数据是上一次的残留，绝不能当真。
  try {
    const st = await chart.getState();
    return (st.studies || []).some(s => s.name === scriptName);
  } catch { return false; }
}

async function collectRun(client, label) {
  // 一次"读"操作：先验证策略真在图上 → apply inputs → read metrics → 拿 meta
  currentStage = 'metrics';
  let chartState0 = {};
  try { chartState0 = await chart.getState(); } catch {}
  if (!(await verifyStrategyOnChart(client))) {
    log(`  ✗ 策略 "${scriptName}" 不在图表上 —— 未应用成功，拒绝返回残留 metrics`);
    return {
      meta: { symbol: chartState0.symbol || null, timeframe: chartState0.resolution || null,
              chart_type: chartState0.chartType || null, label: label || null, tag },
      metrics: null,
      error: 'strategy_not_applied: 图表上无此策略 study，回测未真正运行（避免读到残留数据）',
    };
  }
  await applyStrategyInputs(client);
  await showStrategyTester(client);
  if (!(await selectTargetStrategy(client))) {
    return {
      meta: { symbol: chartState0.symbol || null, timeframe: chartState0.resolution || null,
              chart_type: chartState0.chartType || null, label: label || null, tag },
      metrics: null,
      error: 'strategy_select_failed: Strategy Tester 未能定位到目标策略，读数不可信（避免读到别的策略的残留数据）',
    };
  }
  // 确保从 Overview 抓主 KPI（A2.1 navigate Benchmarking 会切走，下一轮要切回来）
  try { const ov = await navigateOverviewTab(client); if (ov?.found) await sleep(1200); } catch (e) { log(`  WARN: navigateOverview: ${e.message}`); }
  await waitForStrategyReportReady(client);
  const metrics = await readMetrics(client);
  let benchmarkSource = metrics?.buy_hold_return ? 'strategy_results' : null;
  assertRuntimeMetricsCredible(metrics, Object.keys(flags.inputs).length > 0);
  // A2.1: navigate Benchmarking sub-tab 抓真实 B&H 值（主面板的 B&H 是图例刻度，不准确）
  if (!metrics?.buy_hold_return) {
    try {
      const nav = await navigateBenchmarkTab(client);
      if (nav?.found) {
        log(`  navigate Benchmarking sub-tab (${nav.label})`);
        await sleep(1800);
        const bh = await readBenchmarkBH(client);
        log(`  benchmark sub-tab read: ${JSON.stringify(bh)}`);
        if (bh?.bh_return && !/\s[KMB]\b/.test(bh.bh_return)) {
          metrics.buy_hold_return = bh.bh_return;
          benchmarkSource = 'strategy_tester_benchmarking';
        }
        if (bh?.strategy_return) metrics.strategy_return_bench = bh.strategy_return;
      } else {
        log(`  Benchmarking sub-tab not found, skip A2.1`);
      }
    } catch (e) { log(`  WARN: A2.1 navigate failed: ${e.message}`); }
  }
  const rangeEvidence = await captureEvaluationRange(client);
  // polish avg_win_loss: 主路径抓不到时 navigate 交易分析详情 sub-tab 单独取
  if (!metrics?.avg_win_loss) {
    try {
      const nav = await navigateTradeAnalysisTab(client);
      if (nav?.found) {
        log(`  navigate Trade Analysis sub-tab (${nav.label})`);
        await sleep(1500);
        const v = await readAvgWinLoss(client);
        if (v) { metrics.avg_win_loss = v; log(`  avg_win_loss: ${v}`); }
      }
    } catch (e) { log(`  WARN: trade-analysis navigate failed: ${e.message}`); }
  }
  // A2 诊断: 如果仍抓不到，dump 一次 KPI label 帮助校正候选
  if (!_dumpedKpi && !metrics?.buy_hold_return) {
    _dumpedKpi = true;
    try {
      const kpis = await dumpKpiLabels(client);
      log(`KPI labels visible (post-tester): ${JSON.stringify(kpis)}`);
    } catch (e) { log(`  WARN: dumpKpiLabels failed: ${e.message}`); }
  }
  let chartState = {};
  try { chartState = await chart.getState(); } catch (e) { log(`  WARN: getState failed: ${e.message}`); }
  const evaluationEvidence = buildEvaluationEvidence({
    symbol: chartState.symbol || label || null,
    timeframe: chartState.resolution || flags.timeframe || null,
    range: rangeEvidence,
    bhPct: parsePct(metrics.buy_hold_return),
    benchmarkSource,
  });
  let episodeAudit = null;
  if (flags.episodeAudit) {
    const tradeEvidence = await data.getTrades({ strategy_name: scriptName, max_trades: 500 });
    if (!tradeEvidence.success || tradeEvidence.dataset !== 'reportData.trades') {
      throw new Error(tradeEvidence.error || `EPISODE_AUDIT_UNAVAILABLE: ${tradeEvidence.dataset || 'no rich trade dataset'}`);
    }
    episodeAudit = buildEpisodeAudit(tradeEvidence.trades, { strategyName: scriptName });
  }
  const result = {
    meta: {
      symbol: chartState.symbol || null,
      timeframe: chartState.resolution || null,
      chart_type: chartState.chartType || null,
      applied_inputs: Object.keys(flags.inputs).length ? flags.inputs : null,
      label: label || null,
      tag,
      rangeKey: evaluationEvidence.rangeKey,
    },
    metrics,
    evaluation: {
      contextKey: evaluationEvidence.contextKey,
      rangeKey: evaluationEvidence.rangeKey,
      bhPct: evaluationEvidence.bhPct,
      benchmarkSource: evaluationEvidence.benchmarkSource,
    },
    ...(episodeAudit ? { episode: episodeAudit.summary } : {}),
  };
  runEvaluationEvidence.push(evaluationEvidence);
  updateEvaluationSummary();
  const summaryKey = result.meta.label || result.meta.symbol || `run-${summaryRuns.length + 1}`;
  const existingIndex = summaryRuns.findIndex(run => (run.meta?.label || run.meta?.symbol) === summaryKey);
  if (existingIndex >= 0) summaryRuns[existingIndex] = result;
  else summaryRuns.push(result);
  completeStage(runManifest, 'metrics', { evidence: { symbol: result.meta.symbol, strategyName: scriptName, hasMetrics: !!metrics } });
  writeRunManifest();
  return result;
}

async function removeStudiesByName(client, name) {
  // 移除图表上所有名为 name 的 study，返回移除数。不碰 Volume / 用户其它指标。
  let state;
  try { state = await chart.getState(); } catch (e) { log(`  WARN: getState failed: ${e.message}`); return 0; }
  const targets = (state.studies || []).filter(s => s.name === name);
  for (const s of targets) {
    try { await chart.manageIndicator({ action: 'remove', entity_id: s.id }); }
    catch (e) { log(`  WARN: remove study failed: ${e.message}`); }
  }
  return targets.length;
}

async function preCleanStudies(client) {
  // inject 前先清场：① 移除上次保留的我们自己的策略（防堆积，用户手动加的指标不碰）
  //                  ② 移除同名残留（防重复同名 → readMetrics 读错）
  try {
    const last = readFileSync(LAST_STUDY_FILE, 'utf8').trim();
    if (last && last !== scriptName) {
      const k = await removeStudiesByName(client, last);
      if (k > 0) log(`  移除上次保留的 study "${last}"（防堆积）`);
    }
  } catch {}
  const n = await removeStudiesByName(client, scriptName);
  if (n > 0) log(`  pre-clean: 移除 ${n} 个残留同名 study "${scriptName}"`);
}

async function cleanupAppliedStudy(client) {
  // 默认【保留】策略，让用户能在 TV 上核对本次结果；下次跑会被 preClean 自动替换，不堆积。
  // --cleanup 才移除（留干净图表 / selftest 验"无残留"）。
  if (!flags.cleanup) {
    try {
      writeFileSync(LAST_STUDY_FILE, scriptName);
      writeFileSync(LAST_STUDY_META_FILE, JSON.stringify(buildStudyRecord(scriptName, costPatch.code), null, 2));
    } catch {} // 记下，下次跑前移除或安全复用
    log(`  保留图表 study "${scriptName}"（默认，可在 TV 上核对；下次跑自动替换，不堆积。--cleanup 可关）`);
    return;
  }
  const n = await removeStudiesByName(client, scriptName);
  try { unlinkSync(LAST_STUDY_FILE); } catch {}
  try { unlinkSync(LAST_STUDY_META_FILE); } catch {}
  if (n > 0) log(`  cleanup: removed ${n} study "${scriptName}"`);
  else log('  cleanup: 未找到本次 study（可能已不在图上）');
}

function parseNum(str) {
  // 从 "+4,935.75 | +49.36%" / "−6,913.46 | ..." 提取首个数值（绝对值部分）
  if (str == null) return NaN;
  const cleaned = String(str).replace(/[−]/g, '-').replace(/,/g, '');
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

const OBJECTIVE_LABELS = {
  risk_adjusted: '净收益/最大回撤',
  net_pnl: '净收益',
  profit_factor: '盈利因子',
  alpha: 'alpha(跑赢B&H)',
  win_rate_confidence: '胜率置信下界',
};

function parsePct(str) {
  // 从 "−2,365.86 | −23.66%" 提取百分比数值（含百分号的那段）
  if (str == null) return NaN;
  const cleaned = String(str).replace(/[−]/g, '-').replace(/,/g, '');
  const m = cleaned.match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : NaN;
}

function robustnessSummary(runs) {
  // J2: 多 symbol 稳健性一览 — 策略收益% vs B&H% vs alpha，一眼看是否过拟合单票
  const rows = runs.map(r => {
    const m = r.metrics;
    if (!m) return { symbol: r.meta.symbol, error: r.error || 'no metrics（策略未应用）' };
    if (m.no_trade === true) return { symbol: r.meta.symbol, trades: 0, error: 'no_trades（该市场没有产生交易）' };
    const sp = parsePct(m.total_pnl);
    const bh = parsePct(m.buy_hold_return);
    const alpha = (isFinite(sp) && isFinite(bh)) ? +(sp - bh).toFixed(2) : null;
    return { symbol: r.meta.symbol, strategy_pct: isFinite(sp) ? sp : null, bh_pct: isFinite(bh) ? bh : null,
             alpha_pct: alpha, trades: m.total_trades, profit_factor: m.profit_factor };
  });
  const beat = rows.filter(r => r.alpha_pct != null && r.alpha_pct > 0).length;
  return { beat_bh: `${beat}/${rows.length}`, rows };
}

function scanObjective(metrics) {
  return scanObjectiveFromMetrics(metrics, flags.objective);
}

function expandScans(scans) {
  // 笛卡尔积展开多个 --scan 区间 → input 组合数组
  const axes = scans.map(s => {
    const vals = [];
    const eps = Math.abs(s.step) / 1000 || 1e-9;
    for (let v = s.start; v <= s.end + eps; v += s.step) {
      vals.push(Math.round(v * 1e6) / 1e6); // 去浮点尾差
    }
    return { name: s.name, vals };
  });
  let combos = [{}];
  for (const ax of axes) {
    const next = [];
    for (const c of combos) for (const v of ax.vals) next.push({ ...c, [ax.name]: v });
    combos = next;
  }
  return combos;
}

async function scanOneCombo(client, combo, sym, label) {
  // 跑一组参数 → 读主 KPI → 算目标函数 → 落 JSONL → 返回 row。scan 和 auto-tune 共用。
  // 合并 --input 固定覆盖：scan 每组先铺 flags.inputs（如固定 Long Only=true），再叠本组扫描值（combo 优先）。
  // 这样"扫参数时固定某些结构开关"无需另做 pine 变体。
  await applyStrategyInputs(client, { ...flags.inputs, ...combo });
  await showStrategyTester(client);
  if (!(await selectTargetStrategy(client))) {
    throw new Error(`scan target strategy not found or not selectable: ${scriptName}`);
  }
  try { const ov = await navigateOverviewTab(client); if (ov?.found) await sleep(1000); } catch {}
  await waitForStrategyReportReady(client);
  const metrics = await readMetrics(client); // internal reportData first; DOM remains a guarded fallback
  // getStrategyResults already returns the same-run B&H value from TradingView's
  // strategy report. Treat it as first-class evidence, just like a normal run.
  // Previously scan cells kept the value but dropped its source, so an alpha
  // search was incorrectly downgraded to risk_adjusted after all cells ran.
  let benchmarkSource = metrics?.buy_hold_return ? 'strategy_results' : null;
  assertRuntimeMetricsCredible(metrics, true);
  if (flags.objective === 'alpha' && !benchmarkSource) {
    try {
      const nav = await navigateBenchmarkTab(client);
      if (nav?.found) {
        await sleep(1000);
        const bh = await readBenchmarkBH(client);
        if (bh?.bh_return) {
          metrics.buy_hold_return = bh.bh_return;
          benchmarkSource = 'strategy_tester_benchmarking';
        }
        if (bh?.strategy_return) metrics.strategy_return_bench = bh.strategy_return;
      }
    } catch (e) { log(`  WARN: 读本格 B&H 失败: ${e.message}`); }
  }
  const objective = scanObjective(metrics);
  const strategyPct = parsePct(metrics.total_pnl);
  const bhPct = parsePct(metrics.buy_hold_return);
  const alphaPct = (isFinite(strategyPct) && isFinite(bhPct)) ? +(strategyPct - bhPct).toFixed(2) : null;
  let chartState = {};
  try { chartState = await chart.getState(); } catch (e) { log(`  WARN: scan getState failed: ${e.message}`); }
  const rangeEvidence = await captureEvaluationRange(client);
  const evaluationEvidence = buildEvaluationEvidence({
    symbol: chartState.symbol || sym,
    timeframe: chartState.resolution || flags.timeframe,
    range: rangeEvidence,
    bhPct,
    benchmarkSource,
  });
  let episodeAudit = null;
  if (flags.episodeAudit) {
    const tradeEvidence = await data.getTrades({ strategy_name: scriptName, max_trades: 500 });
    if (!tradeEvidence.success || tradeEvidence.dataset !== 'reportData.trades') {
      throw new Error(tradeEvidence.error || `EPISODE_AUDIT_UNAVAILABLE: ${tradeEvidence.dataset || 'no rich trade dataset'}`);
    }
    episodeAudit = buildEpisodeAudit(tradeEvidence.trades, { strategyName: scriptName });
  }
  const row = { ts: new Date().toISOString(), symbol: sym, params: combo,
    net_pnl: metrics.total_pnl, max_drawdown: metrics.max_drawdown,
    total_trades: metrics.total_trades, profit_factor: metrics.profit_factor,
    win_pct: metrics.win_pct, winning_trades: metrics.winning_trades,
    buy_hold_return: metrics.buy_hold_return,
    strategy_return_bench: metrics.strategy_return_bench,
    ...(isFinite(bhPct) ? { bh_pct: bhPct } : {}),
    ...(alphaPct != null ? { alpha_pct: alphaPct, beat_bh: alphaPct > 0 ? 'yes' : 'no' } : {}),
    ...(benchmarkSource ? { benchmarkSource } : {}),
    contextKey: evaluationEvidence.contextKey,
    rangeKey: evaluationEvidence.rangeKey,
    evaluationEvidence,
    ...(episodeAudit ? { episode: episodeAudit.summary } : {}),
    objective };
  candidateEvaluationEvidence.push(evaluationEvidence);
  appendFileSync(SCAN_JSONL, JSON.stringify(row) + '\n');
  log(`  ${label} ${JSON.stringify(combo)} → obj=${isFinite(objective)?objective.toFixed(3):objective} (pnl=${metrics.total_pnl}, bh=${metrics.buy_hold_return || 'n/a'}, dd=${metrics.max_drawdown})`);
  return row;
}

async function runScan(client) {
  // P0-J4: 参数扫描。批量在脚本内跑，全量落 JSONL，只回传 Top-K 紧凑摘要（token 与扫描规模脱钩）。
  const combos = expandScans(flags.scans);
  if (flags.budget && combos.length > flags.budget) {
    log(`  ⚠️ 组合数 ${combos.length} 超预算 ${flags.budget}，截断到前 ${flags.budget} 组`);
    combos.length = flags.budget;
  }
  const sym = (flags.symbols && flags.symbols[0]) || flags.symbol || null;
  log(`scan: ${flags.scans.map(s => `${s.name}=${s.start}..${s.end}:${s.step}`).join(' × ')} → ${combos.length} 组合, symbol=${sym || '(current)'}`);
  const estMin = Math.round(combos.length * 13 / 60);
  log(`  预计 ~${combos.length * 13}s (~${estMin}min)；目标函数=${OBJECTIVE_LABELS[flags.objective]}`);

  await switchSymbol(sym);
  await setTimeframeIfRequested();
  await injectOrReuse(client);
  await verifyDeclaredSourceInputs(client);

  const jsonlPath = SCAN_JSONL;
  const results = [];
  for (let i = 0; i < combos.length; i++) {
    results.push(await scanOneCombo(client, combos[i], sym, `[${i+1}/${combos.length}]`));
  }
  const evaluation = updateEvaluationSummary();

  log('=== SCAN SUMMARY ===');
  const scanSummary = buildScanSummary({
    pineFile, scriptName, symbol: sym,
    costs: costPatch.costs,
    objective: flags.objective,
    objectiveLabel: OBJECTIVE_LABELS[flags.objective],
    scanned: combos.length,
    jsonlPath,
    results,
    evaluation,
  });
  optimizationSummary = scanSummary;
  console.log(JSON.stringify(scanSummary, null, 2));

  // 2 个轴展示完整矩阵；3 个轴以上固定 Top-1 的其余参数，展示可审计的二维切片。
  if (flags.scans.length >= 2 && scanSummary.best?.params) {
    try {
      const hm = buildHeatmapSlice(results, flags.scans, scanSummary.best.params, null, flags.inputs, evaluation);
      writeFileSync(HEATMAP_JSON, JSON.stringify(hm, null, 2));
      currentHeatmapPath = HEATMAP_JSON;
      log(`  热力图网格已写: ${HEATMAP_JSON}（${hm.cells.length} 格，metric=${hm.metric}）`);
    } catch (e) { log(`  WARN: 写热力图网格失败: ${e.message}`); }
  }

  if (scanSummary.best) {
    await restorePrimaryOptimizationState(client, sym, scanSummary.best.params, flags.inputs);
    proofExpectedParams = mergeProvenInputs(flags.sourceInputs, { ...flags.inputs, ...scanSummary.best.params });
  }
  await clearStuckLoadingOverlay(client);
  await captureProof(client, proofExpectedParams);
  await cleanupAppliedStudy(client);
  await client.close();
  log('done.');
}

function axesFromResults(specs, results) {
  return specs.map(s => ({
    name: s.name,
    values: [...new Set(results.map(r => r.params?.[s.name]).filter(v => v != null))]
      .sort((a, b) => Number(a) - Number(b)),
  }));
}

async function restorePrimaryOptimizationState(client, primarySymbol, bestParams, baseInputs) {
  if (primarySymbol) await switchSymbol(primarySymbol);
  const topInputs = { ...baseInputs, ...bestParams };
  await applyStrategyInputs(client, topInputs);
  await showStrategyTester(client);
  if (!(await selectTargetStrategy(client))) {
    throw new Error(`cannot restore P2 proof state for ${primarySymbol || 'current symbol'}`);
  }
  try {
    const overview = await navigateOverviewTab(client);
    if (overview?.found) await sleep(1200);
  } catch {}
}

async function runOptimize(client) {
  // P2 深度优化：显式 opt-in。目标是看稳健性和过拟合风险，不是默认找最高收益。
  const sym = (flags.symbols && flags.symbols[0]) || flags.symbol || null;
  const fullGrid = buildCoarseGrid(flags.optimize, null);
  const totalBudget = resolveOptimizationBudget(fullGrid.total, flags.budget);
  const coarseBudget = fullGrid.total > totalBudget
    ? Math.max(1, Math.ceil(totalBudget * 0.6))
    : totalBudget;
  const coarseGrid = buildCoarseGrid(flags.optimize, coarseBudget);

  log(`P2 optimize: ${flags.optimize.map(s => `${s.name}=${s.start}..${s.end}:${s.step}`).join(' × ')}`);
  log(`  symbol=${sym || '(current)'}, objective=${OBJECTIVE_LABELS[flags.objective]}, budget=${totalBudget}, coarse=${coarseGrid.combos.length}/${fullGrid.total}`);
  log('  用途：检查参数高原、B&H 口径和验证风险；不会默认替代 baseline。');

  await switchSymbol(sym);
  await setTimeframeIfRequested();
  await injectOrReuse(client);
  await verifyDeclaredSourceInputs(client);

  const results = [];
  for (let i = 0; i < coarseGrid.combos.length; i++) {
    results.push(await scanOneCombo(client, coarseGrid.combos[i], sym, `粗[${i+1}/${coarseGrid.combos.length}]`));
  }
  updateEvaluationSummary();

  let summaryAxes = axesFromResults(flags.optimize, results);
  let summary = buildOptimizationSummary({
    mode: 'coarse-to-local',
    objective: flags.objective,
    evaluation: evaluationSummary,
    budget: totalBudget,
    axes: summaryAxes,
    rows: results,
    topK: 5,
    coarse: { planned: coarseGrid.combos.length, total: fullGrid.total, truncated: coarseGrid.truncated },
  });

  const best = summary.top[0];
  const budgetLeft = Math.max(0, totalBudget - results.length);
  const shapeAllowsRefine = best && budgetLeft > 0 && !['isolated_peak', 'noisy', 'insufficient', 'no_edge'].includes(summary.shape?.type);
  let refinePlan = { combos: [] };
  if (shapeAllowsRefine) {
    refinePlan = planLocalRefinement({
      axes: flags.optimize,
      bestParams: best.params,
      testedParams: results.map(r => r.params),
      budgetLeft: Math.min(budgetLeft, Math.max(1, Math.floor(totalBudget * 0.4))),
    });
    if (refinePlan.combos.length) log(`  [局部细扫] 围绕 ${JSON.stringify(best.params)} 追加 ${refinePlan.combos.length} 组`);
    for (let i = 0; i < refinePlan.combos.length; i++) {
      results.push(await scanOneCombo(client, refinePlan.combos[i], sym, `细[${i+1}/${refinePlan.combos.length}]`));
    }
  } else if (budgetLeft > 0) {
    log(`  跳过局部细扫：shape=${summary.shape?.type || 'unknown'}，避免追孤立亮格。`);
  }

  summaryAxes = axesFromResults(flags.optimize, results);
  updateEvaluationSummary();
  summary = buildOptimizationSummary({
    mode: 'coarse-to-local',
    objective: flags.objective,
    evaluation: evaluationSummary,
    budget: totalBudget,
    axes: summaryAxes,
    rows: results,
    topK: 5,
    coarse: { planned: coarseGrid.combos.length, total: fullGrid.total, truncated: coarseGrid.truncated },
    refinement: { planned: refinePlan.combos.length, ran: Math.max(0, results.length - coarseGrid.combos.length) },
  });

  if (flags.symbols && flags.symbols.length > 1 && summary.top[0]) {
    log(`  [验证] 用 Top-1 参数跑 ${flags.symbols.length} 个 symbol: ${flags.symbols.join(', ')}`);
    const originalInputs = flags.inputs;
    flags.inputs = { ...flags.inputs, ...summary.top[0].params };
    const runs = [];
    for (let i = 0; i < flags.symbols.length; i++) {
      const target = flags.symbols[i];
      if (i > 0 || target !== sym) await switchSymbol(target);
      runs.push(await collectRun(client, target));
    }
    const robust = robustnessSummary(runs);
    summary.validation = summarizeValidationRows(robust.rows.map(r => ({ ...r, benchmarkSource: r.error ? null : 'run_benchmarking' })));
    flags.inputs = originalInputs;
  }

  // A scan finishes on its last cell (or last validation market), not on Top-1.
  // Restore the primary symbol and winning inputs for every optimization run,
  // including single-symbol runs, before proof verification and screenshots.
  if (summary.top[0]) {
    await restorePrimaryOptimizationState(client, sym, summary.top[0].params, flags.inputs);
  }

  if (flags.oos || flags.walkForward) {
    summary.oos = buildOosSummary({
      method: flags.walkForward ? `walk-forward ${flags.walkForward} windows` : `split ${flags.oos}/${100 - flags.oos}`,
      status: 'unavailable',
    });
  }

  optimizationSummary = summary;
  writeFileSync(OPTIMIZATION_JSON, JSON.stringify(summary, null, 2));
  completeStage(runManifest, 'optimization', { artifacts: { optimization: OPTIMIZATION_JSON } });
  log('=== OPTIMIZATION SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  log(`  深度优化 JSON 已写: ${OPTIMIZATION_JSON}`);

  if (flags.optimize.length >= 2 && summary.top[0]?.params) {
    try {
      const hm = buildHeatmapSlice(results, flags.optimize, summary.top[0].params, null, flags.inputs, evaluationSummary);
      writeFileSync(HEATMAP_JSON, JSON.stringify(hm, null, 2));
      currentHeatmapPath = HEATMAP_JSON;
      writeRunSummary();
      log(`  热力图网格已写: ${HEATMAP_JSON}（${hm.cells.length} 格，metric=${hm.metric}）`);
    } catch (e) { log(`  WARN: 写热力图网格失败: ${e.message}`); }
  }

  await clearStuckLoadingOverlay(client);
  proofExpectedParams = mergeProvenInputs(flags.sourceInputs, summary.top[0]?.params ? { ...flags.inputs, ...summary.top[0].params } : flags.inputs);
  await captureProof(client, proofExpectedParams);
  await cleanupAppliedStudy(client);
  await client.close();
  log('done.');
}

function intRange(min, max, step) {
  const out = [];
  for (let v = min; v <= max + 1e-9; v += step) out.push(Math.round(v));
  return [...new Set(out)].filter(v => v >= min && v <= max);
}

async function runAutoTune(client) {
  // 弱 Agent 命门：引擎内部自动粗→细，一条命令返回最优参数。不需 Agent 判断该往哪缩区间。
  const { name, min, max } = flags.autoTune;
  const sym = (flags.symbols && flags.symbols[0]) || flags.symbol || null;
  const coarseStep = Math.max(1, Math.round((max - min) / 6)); // 粗扫约 7 个点
  log(`auto-tune: ${name}=${min}..${max}, symbol=${sym || '(current)'}, 目标=${OBJECTIVE_LABELS[flags.objective]}`);

  await switchSymbol(sym);
  await setTimeframeIfRequested();
  await injectOrReuse(client);
  await verifyDeclaredSourceInputs(client);

  // 阶段 1：粗扫
  const coarseVals = intRange(min, max, coarseStep);
  if (flags.budget && coarseVals.length > flags.budget) { log(`  ⚠️ 粗扫 ${coarseVals.length} 超预算 ${flags.budget}，截断`); coarseVals.length = flags.budget; }
  log(`  [粗扫] ${name} ∈ {${coarseVals.join(',')}} (step=${coarseStep})`);
  const rows = [];
  for (let i = 0; i < coarseVals.length; i++) {
    rows.push(await scanOneCombo(client, { [name]: coarseVals[i] }, sym, `粗[${i+1}/${coarseVals.length}]`));
  }
  updateEvaluationSummary();
  const coarseSummary = buildScanSummary({
    pineFile, scriptName, symbol: sym, costs: costPatch.costs,
    objective: flags.objective, objectiveLabel: OBJECTIVE_LABELS[flags.objective],
    evaluation: evaluationSummary, scanned: rows.length, jsonlPath: SCAN_JSONL, results: rows,
  });
  let best = coarseSummary.best;
  if (!best) { log('  粗扫无有效结果，放弃'); await client.close(); return; }
  const center = best.params[name];

  // 阶段 2：在最优点附近 ±coarseStep 细扫
  const fineStep = Math.max(1, Math.round(coarseStep / 5));
  const fineVals = intRange(Math.max(min, center - coarseStep), Math.min(max, center + coarseStep), fineStep)
    .filter(v => !coarseVals.includes(v)); // 跳过粗扫已跑过的点
  if (flags.budget) { const left = Math.max(0, flags.budget - rows.length); if (fineVals.length > left) { log(`  ⚠️ 细扫剩余预算 ${left}，截断`); fineVals.length = left; } }
  log(`  [细扫] 最优点 ${name}=${center} 附近 {${fineVals.join(',')}} (step=${fineStep})`);
  for (let i = 0; i < fineVals.length; i++) {
    rows.push(await scanOneCombo(client, { [name]: fineVals[i] }, sym, `细[${i+1}/${fineVals.length}]`));
  }
  updateEvaluationSummary();

  // 全程最优
  const finalSummary = buildScanSummary({
    pineFile, scriptName, symbol: sym, costs: costPatch.costs,
    objective: flags.objective, objectiveLabel: OBJECTIVE_LABELS[flags.objective],
    evaluation: evaluationSummary, scanned: rows.length, jsonlPath: SCAN_JSONL, results: rows,
  });
  optimizationSummary = finalSummary;
  best = finalSummary.best;
  const ranked = finalSummary.top;
  log('=== AUTO-TUNE RESULT ===');
  console.log(JSON.stringify({
    pine_file: pineFile, script_name: scriptName, symbol: sym,
    ...(costPatch.costs ? { costs: costPatch.costs } : {}),
    tuned_param: name, objective: OBJECTIVE_LABELS[flags.objective], effective_objective: finalSummary.effective_objective,
    evaluation: evaluationSummary, evaluated: rows.length, jsonl: SCAN_JSONL,
    best: { params: best.params, net_pnl: best.net_pnl, max_drawdown: best.max_drawdown,
            profit_factor: best.profit_factor, win_pct: best.win_pct, objective: Math.round(best.objective*1000)/1000 },
    top3: ranked.slice(0, 3),
    next_step: `用最优参数做完整 run + 跨市场稳健性: --symbols <票1>,<票2> --input ${name}=${best.params[name]}`,
  }, null, 2));

  await clearStuckLoadingOverlay(client);
  const runtimeTopInputs = { ...flags.inputs, [name]: best.params[name] };
  proofExpectedParams = mergeProvenInputs(flags.sourceInputs, runtimeTopInputs);
  await applyStrategyInputs(client, runtimeTopInputs);
  await captureProof(client, proofExpectedParams);
  await cleanupAppliedStudy(client);
  await client.close();
  log('done.');
}

async function runSelfTest(client) {
  // 端到端自检：捆绑 CRSI 在 BATS:SOXX 跑一次，断言结构 + 合理区间（容忍数据漂移，不查历史精确值）。
  const sym = flags.symbol;
  log(`selftest: ${scriptName} on ${sym}`);
  await switchSymbol(sym);
  await injectOrReuse(client);
  await verifyDeclaredSourceInputs(client);
  const run = await collectRun(client, sym);
  const m = run.metrics;
  if (!m) {
    log(`  ✗ selftest FAIL: ${run.error || '策略未应用，无 metrics'}`);
    console.log(JSON.stringify({ selftest: 'FAIL', failed: 9, error: run.error }, null, 2));
    await client.close(); process.exitCode = 1; return;
  }
  const trades = parseNum(m.total_trades), pf = parseNum(m.profit_factor);

  // 跑完清理 + 验图表干净
  await cleanupAppliedStudy(client);
  let leftover = -1;
  try { const st = await chart.getState(); leftover = (st.studies || []).filter(s => s.name === scriptName).length; } catch {}
  let tagOK = false;
  try { const src = await pine.getSource(); tagOK = src.source.includes(tag); } catch {}

  const checks = [
    ['total_trades 正整数 >50', isFinite(trades) && trades > 50],
    ['profit_factor 数值 >0', isFinite(pf) && pf > 0],
    ['total_pnl 非空', !!m.total_pnl],
    ['max_drawdown 非空', !!m.max_drawdown],
    ['win_pct 非空', !!m.win_pct],
    ['buy_hold_return 非空 (B&H sub-tab)', !!m.buy_hold_return],
    ['avg_win_loss 非空 (Trade Analysis sub-tab)', !!m.avg_win_loss],
    ['图表无残留 study (清理生效)', leftover === 0],
    ['tag 写入编辑器 (注入生效)', tagOK],
  ];
  log('=== SELFTEST RESULT ===');
  let fail = 0;
  for (const [name, pass] of checks) { log(`  ${pass ? '✓' : '✗'} ${name}`); if (!pass) fail++; }
  log(`  metrics: trades=${m.total_trades} pf=${m.profit_factor} pnl=${m.total_pnl} bh=${m.buy_hold_return}`);
  console.log(JSON.stringify({ selftest: fail === 0 ? 'PASS' : 'FAIL', failed: fail, symbol: sym, metrics: m }, null, 2));

  await clearStuckLoadingOverlay(client);
  await client.close();
  log(fail === 0 ? 'selftest PASS' : `selftest FAIL (${fail})`);
  process.exitCode = fail === 0 ? 0 : 1;
}

async function main() {
  log(`script=${pineFile}, name="${scriptName}", tag=${tag}`);
  if (flags.selftest) {
    const client = await getChartClient();
    await client.Runtime.enable();
    await client.Page.enable();
    await dismissModalIfAny(client);
    return await runSelfTest(client);
  }
  if (flags.autoTune) {
    const client = await getChartClient();
    await client.Runtime.enable();
    await client.Page.enable();
    await dismissModalIfAny(client);
    return await runAutoTune(client);
  }
  if (flags.optimize.length) {
    const client = await getChartClient();
    await client.Runtime.enable();
    await client.Page.enable();
    await dismissModalIfAny(client);
    return await runOptimize(client);
  }
  if (flags.scans.length) {
    const client = await getChartClient();
    await client.Runtime.enable();
    await client.Page.enable();
    await dismissModalIfAny(client);
    return await runScan(client);
  }
  // D9: 多 symbol 列表。优先 --symbols（逗号分隔），其次 --symbol，都没传则单次跑当前 symbol
  const symbolList = flags.symbols && flags.symbols.length ? flags.symbols
                   : flags.symbol ? [flags.symbol]
                   : [null]; // null 表示用当前 chart 的 symbol
  if (symbolList.length > 1 || flags.timeframe || Object.keys(flags.inputs).length) {
    log(`flags: ${JSON.stringify(flags)}`);
  }
  log(`symbols to run: ${symbolList.map(s => s || '(current)').join(', ')}`);

  const client = await getChartClient();
  await client.Runtime.enable();
  await client.Page.enable();
  await dismissModalIfAny(client);

  // 第一阶段: 一次性 inject + apply + save 到库
  await switchSymbol(symbolList[0]);
  await setTimeframeIfRequested();
  await injectOrReuse(client);
  await verifyDeclaredSourceInputs(client);

  // 第二阶段: 对每个 symbol 收集 metrics（A2 KPI dump 在 collectRun 内部按需触发）
  const runs = [];
  for (let i = 0; i < symbolList.length; i++) {
    const sym = symbolList[i];
    if (i > 0) await switchSymbol(sym); // 第一个已经切过了
    runs.push(await collectRun(client, sym));
  }

  log('=== RESULTS ===');
  console.log(JSON.stringify({
    pine_file: pineFile,
    script_name: scriptName,
    ...(costPatch.costs ? { costs: costPatch.costs } : {}),
    runs,
  }, null, 2));

  // J2: 多 symbol 跑完给一张稳健性汇总（策略 vs B&H vs alpha）
  if (runs.length > 1) {
    log('=== ROBUSTNESS SUMMARY ===');
    console.log(JSON.stringify(robustnessSummary(runs), null, 2));
  }

  await clearStuckLoadingOverlay(client);
  if (symbolList.length > 1 && primarySymbol) {
    await switchSymbol(primarySymbol);
    await applyStrategyInputs(client, flags.inputs);
  }
  await captureProof(client, mergeProvenInputs(flags.sourceInputs, flags.inputs));
  await cleanupAppliedStudy(client);
  try {
    const src = await pine.getSource();
    log(`tag in source: ${src.source.includes(tag)} (${src.line_count} lines)`);
  } catch (e) {
    log(`tag verify skipped: ${e.message}`);
  }
  await client.close();
  log('done.');
}

main().then(() => {
  finishManifest(runManifest);
  writeRunManifest();
  process.exit(process.exitCode || 0);
}).catch(e => {
  failManifest(runManifest, e, currentStage);
  writeRunManifest();
  console.error(JSON.stringify({ ok: false, error: runManifest.error, manifest: RUN_MANIFEST_JSON }, null, 2));
  process.exit(1);
});
