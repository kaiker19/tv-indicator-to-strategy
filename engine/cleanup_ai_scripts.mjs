// C8: 批量清理 TV 用户脚本库里 "[AI] " 前缀的脚本（auto_inject 生成的策略），避免污染私人库。
// 用法:
//   node cleanup_ai_scripts.mjs            # dry-run，只列出会删哪些（默认安全）
//   node cleanup_ai_scripts.mjs --confirm  # 实际删除
//   node cleanup_ai_scripts.mjs --prefix "[AI] " --confirm   # 自定义前缀
import CDP from 'chrome-remote-interface';

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
const prefixIdx = argv.indexOf('--prefix');
const PREFIX = prefixIdx !== -1 ? argv[prefixIdx + 1] : '[AI] ';
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function getChartClient() {
  let targets;
  try { targets = await CDP.List(); }
  catch { throw new Error('CDP not reachable on 9222. Launch TV with TVD_DEBUGMODE=true ... --remote-debugging-port=9222'); }
  const chart = targets.find(t => t.url.includes('tradingview.com/chart'));
  if (!chart) throw new Error('No TradingView chart tab found');
  return await CDP({ target: chart.webSocketDebuggerUrl });
}

async function main() {
  const client = await getChartClient();
  await client.Runtime.enable();
  const probe = async (expr) => {
    const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  // 1. 拉取 saved 脚本列表
  const all = await probe(`fetch("https://pine-facade.tradingview.com/pine-facade/list/?filter=saved",{credentials:"include"}).then(function(r){return r.json();}).then(function(d){return Array.isArray(d)?d.map(function(s){return {name:s.scriptName||s.scriptTitle, id:s.scriptIdPart};}):{err:d};})`);
  if (all?.err) throw new Error('pine-facade list failed: ' + JSON.stringify(all.err));

  const targets = all.filter(s => (s.name || '').startsWith(PREFIX));
  log(`saved scripts total: ${all.length}, matching prefix "${PREFIX}": ${targets.length}`);
  targets.forEach(s => log(`  - ${s.name}  (${s.id})`));

  if (!targets.length) { log('nothing to clean.'); await client.close(); return; }

  if (!confirm) {
    log('DRY-RUN (默认)。确认无误后加 --confirm 实际删除。');
    await client.close();
    return;
  }

  // 2. 逐个删除（POST /pine-facade/delete/<encoded id>）
  let ok = 0, fail = 0;
  for (const s of targets) {
    const res = await probe(`fetch("https://pine-facade.tradingview.com/pine-facade/delete/" + encodeURIComponent(${JSON.stringify(s.id)}), {method:"POST", credentials:"include"}).then(function(r){return r.text().then(function(t){return {status:r.status, body:t.slice(0,120)};});}).catch(function(e){return {err:e.message};})`);
    if (res?.status === 200) { ok++; log(`  ✓ deleted ${s.name}`); }
    else { fail++; log(`  ✗ failed ${s.name}: ${JSON.stringify(res)}`); }
  }
  log(`done. deleted ${ok}, failed ${fail}.`);
  await client.close();
}

main().then(() => process.exit(0)).catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
