// J7: 按名检索指标 → 返回可用于转换的来源。
// 用法: node resolve_indicator.mjs "<名称>" [--kind saved|standard|community|all]
//       node resolve_indicator.mjs --id "PUB;xxxx" [--out /tmp/source.pine]
//   saved     用户已存脚本（含源码，可直接转换）
//   standard  TV 内置标准指标（源码专有；Claude 凭知识写策略）
//   community TV 社区公开脚本（开源的含源码 scriptSource；受保护的拿不到）
//   all       三者都查（默认）
// 输出 JSON: { query, found, matches:[{name, kind, id, author?, access?, source?, note?}], hint }
import CDP from 'chrome-remote-interface';
import { extractPublicScriptLinks, parsePublicScriptMetadata } from './public_script_lookup.mjs';
import { parseResolveArgs } from './resolve_args.mjs';
import { compactResolvedSource } from './resolve_output.mjs';

const argv = process.argv.slice(2);
const { kind: KIND, directId, outputPath, query } = parseResolveArgs(argv);
if (!query && !directId) { console.error('usage: node resolve_indicator.mjs "<名称>" [--kind saved|standard|community|all] [--out file] | --id "PUB;xxx" [--out file]'); process.exit(1); }

function emitResult(result) {
  compactResolvedSource(result, outputPath);
  console.log(JSON.stringify(result, null, 2));
}

async function getClient() {
  let targets;
  try { targets = await CDP.List(); } catch { throw new Error('CDP not reachable on 9222'); }
  const chart = targets.find(t => t.url.includes('tradingview.com/chart'));
  if (!chart) throw new Error('No TradingView chart tab');
  return await CDP({ target: chart.webSocketDebuggerUrl });
}

async function main() {
  const client = await getClient();
  await client.Runtime.enable();
  const probe = async (expr) => {
    const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  // 取社区脚本源码：先 pubscripts-get 的 scriptSource；它对很多开源脚本返回空（实测 UT Bot Alerts），
  // 回退 pine-facade/get/<id>/last（UI"打开源码"走的就是这条，返回真 source）。
  const getCommunitySource = async (id) =>
    probe(`(async function(){
      var idp = ${JSON.stringify(id)};
      var out = {source:"", access:undefined, name:undefined};
      try { var a = await fetch("https://cn.tradingview.com/pubscripts-get/?scriptIdPart="+encodeURIComponent(idp),{credentials:"include"}).then(r=>r.json());
        var x = Array.isArray(a)?a[0]:a; if (x) { out.source=x.scriptSource||""; out.access=x.access; out.name=x.scriptName; } } catch(e){}
      if (!out.source) { try { var d = await fetch("https://pine-facade.tradingview.com/pine-facade/get/"+encodeURIComponent(idp)+"/last",{credentials:"include"}).then(r=>r.ok?r.json():null);
        if (d && d.source) { out.source=d.source; if(!out.name) out.name=d.scriptName; } } catch(e){} }
      return (out.source || out.name!==undefined) ? out : null;
    })()`);

  // --id 模式：直接取指定社区脚本源码（用于命中太多时消歧后精确取）
  if (directId) {
    const got = await getCommunitySource(directId);
    emitResult({ id: directId, name: got?.name, access: got?.access,
      source: got?.source || null,
      hint: got?.source ? '已取到源码，进转换' : '该脚本源码不可得（受保护或不存在）' });
    await client.close(); return;
  }

  const q = query.toLowerCase();
  const score = (name) => { const n = (name || '').toLowerCase(); return n === q ? 3 : n.startsWith(q) ? 2 : n.includes(q) ? 1 : 0; };
  const matches = [];

  if (KIND === 'saved' || KIND === 'all') {
    const saved = await probe(`fetch("https://pine-facade.tradingview.com/pine-facade/list/?filter=saved",{credentials:"include"}).then(r=>r.json()).then(d=>Array.isArray(d)?d.map(s=>({name:s.scriptName||s.scriptTitle, id:s.scriptIdPart, ver:s.version||1})):[]).catch(()=>[])`);
    for (const s of saved) { const sc = score(s.name); if (sc > 0) matches.push({ name: s.name, kind: 'saved', id: s.id, version: s.ver, _score: sc + 0.5 }); } // 已存优先（已转好/熟悉）
  }
  if (KIND === 'standard' || KIND === 'all') {
    const std = await probe(`fetch("https://pine-facade.tradingview.com/pine-facade/list/?filter=standard",{credentials:"include"}).then(r=>r.json()).then(d=>Array.isArray(d)?d.map(s=>({name:s.scriptName||s.scriptTitle, id:s.scriptIdPart})):[]).catch(()=>[])`);
    for (const s of std) { const sc = score(s.name); if (sc > 0) matches.push({ name: s.name, kind: 'standard', id: s.id, _score: sc, note: '内置指标源码专有，凭知识写策略' }); }
  }
  if (KIND === 'community' || KIND === 'all') {
    // 社区库已按相关度排序；保留 TV 顺序做微调（越靠前越相关）
    const com = await probe(`fetch("https://cn.tradingview.com/pubscripts-suggest-json/?search="+encodeURIComponent(${JSON.stringify(query)}),{credentials:"include"}).then(r=>r.json()).then(function(d){var a=d.results||d||[];return a.slice(0,20).map(function(x,i){return {name:x.scriptName, author:(x.author&&x.author.username)||x.author, id:x.scriptIdPart, access:x.access, rank:i};});}).catch(()=>[])`);
    for (const s of com) {
      const sc = score(s.name);
      // access=1 多数可取源码，但不保证（作者可能未公开 scriptSource）；真凭据是取到非空源码
      if (sc > 0) matches.push({ name: s.name, kind: 'community', id: s.id, author: s.author,
        access: s.access, maybeOpen: s.access === 1, _score: sc + (1 - s.rank / 100) });
    }

    // TradingView 的 suggest API 偶尔不返回公开页面。仅在无社区命中时回退公共搜索页，
    // 最多检查 3 个页面；页面 slug 不是 Pine source id，必须读取 script_id_part。
    if (!matches.some(m => m.kind === 'community')) {
      try {
        const searchHtml = await probe(`fetch("https://www.tradingview.com/scripts/search/"+encodeURIComponent(${JSON.stringify(query)})+"/",{credentials:"include"}).then(r=>r.ok?r.text():"").catch(()=>"")`);
        const links = extractPublicScriptLinks(searchHtml, 3);
        for (let i = 0; i < links.length; i++) {
          const pageHtml = await probe(`fetch(${JSON.stringify(links[i])},{credentials:"include"}).then(r=>r.ok?r.text():"").catch(()=>"")`);
          const meta = parsePublicScriptMetadata(pageHtml);
          if (!meta?.id || score(meta.name) === 0) continue;
          matches.push({
            name: meta.name || query,
            kind: 'community',
            id: meta.id,
            maybeOpen: true,
            publicUrl: links[i],
            _score: score(meta.name) + (1 - i / 100),
            note: '由 TradingView 公共脚本页解析真实 source id',
          });
        }
      } catch {}
    }
  }

  matches.sort((a, b) => b._score - a._score);
  const top = matches.slice(0, 8);

  // 给最佳的「有源码可取」命中拉源码：优先 saved，其次社区开源
  const bestSaved = top.find(m => m.kind === 'saved');
  if (bestSaved) {
    try { const src = await probe(`fetch("https://pine-facade.tradingview.com/pine-facade/get/${bestSaved.id}/${bestSaved.version}",{credentials:"include"}).then(r=>r.json()).then(d=>d.source||"").catch(()=>"")`); if (src) bestSaved.source = src; } catch {}
  }
  // 社区：access=1 不保证有源码，依次取 top 几个开源候选，取到第一个非空源码为止
  if (!bestSaved?.source) {
    for (const m of top.filter(m => m.kind === 'community' && m.maybeOpen).slice(0, 4)) {
      try { const got = await getCommunitySource(m.id); if (got?.source) { m.source = got.source; break; } } catch {}
    }
  }

  const gotSource = top.find(m => m.source);
  emitResult({
    query, found: top.length,
    matches: top.map(({ _score, ...m }) => m),
    hint: gotSource ? `已取到源码（${gotSource.kind}: ${gotSource.name}），进转换`
        : top.some(m => m.kind === 'standard') ? '内置指标：让 Claude 凭知识写策略'
        : top.length ? `命中 ${top.length} 个但没拿到源码（受保护/未公开）；让用户从列表选一个，用 --id "PUB;xxx" 精确取，或贴码`
        : '未检索到；换个关键词、确认拼写，或让用户直接贴源码',
  });
  await client.close();
}

main().then(() => process.exit(0)).catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
