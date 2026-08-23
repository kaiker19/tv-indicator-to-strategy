// 静态自检（无需 TV）：装得上、依赖齐、无残留硬编码路径、语法正确。
// 用法: npm run check  （或 node check.mjs）
import { execSync } from 'child_process';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadCaseLibrary, validateCaseLibrary } from './case_library.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
let fail = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.log(`  ✗ ${m}`); fail++; };

console.log('[1] Node 版本 ≥ 18');
{
  const major = parseInt(process.versions.node.split('.')[0], 10);
  major >= 18 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node}（需 ≥18）`);
}

console.log('[2] 依赖已安装');
existsSync(join(ROOT, 'node_modules', 'chrome-remote-interface'))
  ? ok('chrome-remote-interface')
  : bad('chrome-remote-interface 未安装（跑 npm install）');

function collectSourceFiles(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    if (name === 'research') continue; // 项目型研究由仓库内部 npm test 覆盖，不属于公共 check
    const rel = base ? join(base, name) : name;
    const full = join(dir, name);
    if (name.endsWith('.test.mjs')) continue;
    if (name.endsWith('.mjs') || name.endsWith('.js')) out.push(rel);
    else if (!name.includes('.')) out.push(...collectSourceFiles(full, rel));
  }
  return out.sort();
}

console.log('[3] 语法检查');
const mjs = collectSourceFiles(ROOT);
for (const f of mjs) {
  try { execSync(`node --check "${join(ROOT, f)}"`, { stdio: 'pipe' }); ok(f); }
  catch (e) { bad(`${f}: ${String(e.stderr || e).split('\n')[0]}`); }
}

console.log('[4] import 闭包可解析');
for (const f of ['core/ui.js', 'core/pine.js', 'core/data.js', 'core/chart.js', 'core/indicators.js']) {
  try { await import(join(ROOT, f)); ok(f); }
  catch (e) { bad(`${f}: ${e.message}`); }
}

console.log('[5] 无残留硬编码用户路径（可移植性）');
{
  let found = 0;
  for (const f of mjs) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    // 匹配 /Users/<name>/ 或 /home/<name>/ 这类用户专属绝对路径
    const m = src.match(/\/(Users|home)\/[a-z][a-z0-9_-]+\//gi);
    if (m) { bad(`${f} 含硬编码路径: ${[...new Set(m)].join(', ')}`); found += m.length; }
  }
  if (!found) ok('无 /Users/<name> 或 /home/<name> 硬编码');
}

console.log('[6] CLI 参数解析（关键 flag 正则）');
{
  const src = readFileSync(join(ROOT, 'auto_inject.mjs'), 'utf8');
  for (const flag of ['--scan', '--optimize', '--oos', '--walk-forward', '--auto-tune', '--objective', '--symbols', '--input', '--source-input', '--episode-audit', '--keep']) {
    src.includes(`'${flag}'`) ? ok(flag) : bad(`${flag} 解析缺失`);
  }
}

console.log('[7] P5 告警 CLI 安全边界');
{
  const src = readFileSync(join(ROOT, 'alerts.mjs'), 'utf8');
  for (const token of ['--commit', 'dry_run', 'create_alert', 'delete_alerts', 'strategy-probe', 'strategy-create']) {
    src.includes(token) ? ok(token) : bad(`alerts.mjs 缺少 ${token}`);
  }
}

console.log('[8] Strategy Profile CLI 边界');
{
  const src = readFileSync(join(ROOT, 'strategy_profile_cli.mjs'), 'utf8');
  for (const token of ['--meta', '--source', '--out', '--promote', 'atomicWriteJson', 'sanitizeProfileForPromotion']) {
    src.includes(token) ? ok(token) : bad(`strategy_profile_cli.mjs 缺少 ${token}`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  pkg.bin?.['tv-profile'] === './strategy_profile_cli.mjs' ? ok('tv-profile bin') : bad('package.json 缺少 tv-profile bin');
}

console.log('[9] 四类策略证据库');
{
  try {
    const indexPath = join(ROOT, '..', 'profiles', 'index.json');
    if (!existsSync(indexPath)) {
      ok('公共包不内置历史策略档案');
    } else {
      const loaded = loadCaseLibrary(indexPath);
      const result = validateCaseLibrary(loaded.index, loaded.profiles);
      if (result.errors.length) result.errors.forEach(error => bad(error));
      else ok(`${result.summary.total} 个案例，${result.summary.qualified} 个合格正例，覆盖 ${result.summary.families.join(', ')}`);
    }
  } catch (error) {
    bad(error.message);
  }
}

console.log('[10] Strategy Spec 编译器边界');
{
  const src = readFileSync(join(ROOT, 'strategy_spec_cli.mjs'), 'utf8');
  for (const token of ['validate', 'compile', 'inspect', 'atomicWrite', 'blockingAmbiguities']) {
    src.includes(token) ? ok(token) : bad(`strategy_spec_cli.mjs 缺少 ${token}`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  pkg.bin?.['tv-strategy-spec'] === './strategy_spec_cli.mjs' ? ok('tv-strategy-spec bin') : bad('package.json 缺少 tv-strategy-spec bin');
}

console.log(fail === 0 ? '\n✅ 静态自检全部通过' : `\n❌ ${fail} 项未通过`);
process.exit(fail === 0 ? 0 : 1);
