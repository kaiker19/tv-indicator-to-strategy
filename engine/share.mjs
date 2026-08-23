// 分享卡导出：data.json -> share_card.html -> share_card.png。
// 优先用本机 Chrome headless 直接截 PNG；失败时再尝试 CDP，最终保留 HTML。
import CDP from 'chrome-remote-interface';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { buildShareCard, validateData } from './report.mjs';

const OUTPUT_DIR = process.env.TV_SKILL_OUTPUT_DIR || join(homedir(), '.tv-skill');
mkdirSync(OUTPUT_DIR, { recursive: true });
const TIMEOUT_MS = 10000;

function usage() {
  console.error('用法: node share.mjs <data.json>');
  process.exit(1);
}

function chromeBin() {
  return process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

async function capturePngWithChrome(htmlPath, pngPath) {
  const bin = chromeBin();
  if (!existsSync(bin)) throw new Error(`找不到 Chrome: ${bin}`);
  const userDataDir = process.env.TV_SKILL_CHROME_PROFILE || join(dirname(pngPath), 'chrome-share-profile');
  mkdirSync(userDataDir, { recursive: true });
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--window-size=1080,1350',
    `--user-data-dir=${userDataDir}`,
    `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const startedAt = Date.now();
    const hasPng = () => {
      try {
        const st = statSync(pngPath);
        return st.size > 0 && st.mtimeMs >= startedAt - 1000;
      } catch {
        return false;
      }
    };
    const stopChrome = () => {
      try { if (!child.killed) child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch {} }, 1000).unref();
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      fn(value);
    };
    const poll = setInterval(() => {
      if (hasPng()) {
        stopChrome();
        settle(resolve);
      }
    }, 250);
    poll.unref();
    const timer = setTimeout(() => {
      stopChrome();
      if (hasPng()) settle(resolve);
      else settle(reject, new Error('Chrome 截图超时'));
    }, TIMEOUT_MS);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => {
      settle(reject, err);
    });
    child.on('close', code => {
      if (hasPng()) settle(resolve);
      else settle(reject, new Error(`Chrome 截图失败(${code}): ${stderr.trim() || 'no stderr'}`));
    });
  });
}

async function capturePng(htmlPath, pngPath) {
  let target;
  let client;
  let created = false;
  try {
    try {
      target = await withTimeout(CDP.New({ url: 'about:blank' }), 3000, '新建 CDP 页面超时');
      created = true;
    } catch {
      const targets = await withTimeout(CDP.List(), 3000, '读取 CDP targets 超时');
      target = targets.find(t => t.type === 'page' && !t.url && t.webSocketDebuggerUrl);
      if (!target) throw new Error('Could not create new page and no blank CDP target is available');
    }
    client = await withTimeout(CDP({ target: target.webSocketDebuggerUrl || target }), 5000, '连接 CDP target 超时');
    await withTimeout(client.Page.enable(), 3000, '启用 Page domain 超时');
    await withTimeout(client.Runtime.enable(), 3000, '启用 Runtime domain 超时');
    await withTimeout(client.Emulation.setDeviceMetricsOverride({
      width: 1080,
      height: 1350,
      deviceScaleFactor: 1,
      mobile: false,
    }), 3000, '设置截图视口超时');
    const html = readFileSync(htmlPath, 'utf8');
    await withTimeout(client.Runtime.evaluate({
      expression: `document.open();document.write(${JSON.stringify(html)});document.close();`,
      awaitPromise: true,
    }), TIMEOUT_MS, '写入分享卡 HTML 超时');
    await withTimeout(new Promise(resolve => setTimeout(resolve, 300)), 1000, '等待渲染超时');
    const shot = await withTimeout(client.Page.captureScreenshot({ format: 'png', fromSurface: true }), TIMEOUT_MS, '截图超时');
    writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
    return { ok: true };
  } finally {
    try { if (client && !created) await withTimeout(client.Page.navigate({ url: 'about:blank' }), 1000, '重置空白页超时'); } catch {}
    try { if (client) await withTimeout(client.close(), 1000, '关闭 CDP 连接超时'); } catch {}
    try { if (created && target?.id) await withTimeout(CDP.Close({ id: target.id }), 1000, '关闭新建页面超时'); } catch {}
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

async function main() {
  const dataPath = process.argv[2];
  if (!dataPath) usage();

  const d = JSON.parse(readFileSync(dataPath, 'utf8'));
  const { errors, warnings } = validateData(d);
  warnings.forEach(w => console.error('⚠️  ' + w));
  if (errors.length) {
    errors.forEach(e => console.error('✗ ' + e));
    process.exit(1);
  }

  const htmlOut = d.cardOut || join(OUTPUT_DIR, 'share_card.html');
  const pngOut = d.cardPngOut || join(OUTPUT_DIR, 'share_card.png');
  mkdirSync(dirname(htmlOut), { recursive: true });
  mkdirSync(dirname(pngOut), { recursive: true });

  writeFileSync(htmlOut, buildShareCard(d));
  console.log('分享卡 HTML 已生成:', htmlOut);

  try {
    await capturePngWithChrome(htmlOut, pngOut);
    console.log('分享卡 PNG 已生成:', pngOut);
    return;
  } catch (e) {
    console.error('⚠️  Chrome 截图失败，尝试 CDP。');
    console.error(`   ${e.message}`);
  }

  try {
    await capturePng(htmlOut, pngOut);
    console.log('分享卡 PNG 已生成:', pngOut);
  } catch (e) {
    console.error(`⚠️  CDP 截图失败，已保留 HTML，可手动打开截图: ${htmlOut}`);
    console.error(`   ${e.message}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
