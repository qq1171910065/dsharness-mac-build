#!/usr/bin/env node
/**
 * 验收账号页那两个跳转目标（`/top_up`、`/usage`）**在桌面内嵌视图那条路上**可用。
 *
 * ## 为什么单独验这一条
 *
 * 桌面端点「充值」「查询用量」时，官方账号页把链接交给一个同源
 * `WebContentsView` 打开（`apps/desktop/src/platform-view.ts`），
 * 那个视图的导航守卫是：
 *
 * ```js
 * const allowNavigation = (url) => new URL(url).origin === account.origin
 * view.webContents.on('will-redirect', (event, url) => { if (!allowNavigation(url)) event.preventDefault() })
 * ```
 *
 * 所以只要这两个路径**跳出 platformOrigin**（曾经是 302 到 `ai.czmanong.com`），
 * 跳转就被取消，用户看到一块空白 —— 这就是「充值没法用」的真因。
 *
 * 另一个只在桌面成立的条件是**认证方式**：内嵌文档没有 cookie，
 * 只有官方 preload 暴露的 `window.dsh.getAuthToken()`（就是本地会话 JWT）。
 * 本脚本用 `addInitScript` 注入同一个桥来复现那条路 —— 注意**不种 cookie**，
 * 否则就测成了浏览器那条路。
 *
 * ## 用法
 *
 * ```powershell
 * cd server; npm run dev                    # :13090
 * cd client; $env:DSH_E2E_EMAIL='<已建档邮箱>'; node platform/check-pages.mjs
 * ```
 *
 * 不指定 email 时会跳过「带数据」那几条（页面渲染仍照验）。
 * ⚠️ 会话会因为**官方退登**（`bumpTokenVersion`）整批失效：跑过
 * `server; npm run e2e`（它最后一步 signOut）之后要重新签一次 ——
 * 本脚本每次都重新签，所以不受影响。
 *
 * 退出码 0 = 全过（含「没给邮箱所以只验渲染」）；1 = 有断言失败。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCOUNT = String(process.env.E2E_ACCOUNT || 'http://127.0.0.1:13090').replace(/\/+$/, '');
const EMAIL = String(process.env.DSH_E2E_EMAIL || '').trim();
const SHOTS = process.env.DSH_SHOT_DIR || resolve(process.env.TEMP ?? '.', 'agent-kit', 'dsharness');
const CLIENT_DIR = resolve(import.meta.dirname, '..');
const SERVER_DIR = resolve(CLIENT_DIR, '..', 'server');

/**
 * 现签一份会话（不发邮件）。
 *
 * 直接调 tsx 的 CLI 入口，不走 `npx` —— `npx.cmd` 在 Windows 上会被
 * `execFileSync` 拒（`spawnSync npx.cmd EINVAL`，实测踩到）。
 *
 * @returns 本地会话 JWT；没给邮箱时返回空串。
 */
function mintSession() {
  if (EMAIL === '') return '';
  const tsxCli = resolve(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const output = execFileSync(process.execPath, [
    tsxCli, 'scripts/local-session.mjs', '--email', EMAIL,
  ], { cwd: SERVER_DIR, encoding: 'utf8' });
  return JSON.parse(output).token;
}

const TOKEN = String(process.env.DSH_E2E_TOKEN || '').trim() || mintSession();

/** playwright-core 只装在 client 的 pnpm store 里（未提升到顶层）。 */
const store = resolve(CLIENT_DIR, 'node_modules', '.pnpm');
const dir = readdirSync(store).filter((name) => /^playwright-core@\d/.test(name)).sort().pop();
const { chromium } = await import(pathToFileURL(resolve(store, dir, 'node_modules', 'playwright-core', 'index.mjs')).href);

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1240, height: 900 }, locale: 'zh-CN' });
/*
 * 复现桌面内嵌文档：官方 preload 暴露 `window.dsh.getAuthToken()`。
 * **不加 cookie** —— 那样会变成浏览器那条路，就不是本脚本要验的东西了。
 */
if (TOKEN !== '') {
  await context.addInitScript((grant) => {
    globalThis.dsh = {
      protocolVersion: 1,
      displayMode: 'embedded',
      getLocale: () => 'zh_CN',
      onLocaleChange: () => () => undefined,
      getAuthToken: () => grant,
    };
  }, TOKEN);
}

const page = await context.newPage();

for (const [path, marker] of [['/top_up', 'data-page="top_up"'], ['/usage', 'data-page="usage"']]) {
  const response = await page.goto(`${ACCOUNT}${path}`, { waitUntil: 'domcontentloaded' });
  check(`${path} 直接渲染（200 且无跳转 —— 跳转会被内嵌视图取消）`,
    response.status() === 200 && response.headers().location === undefined,
    `status=${String(response.status())} location=${response.headers().location ?? '(none)'}`);
  const html = await page.content();
  check(`${path} 用的是共用品牌外壳`, html.includes(marker) && html.includes('class="brand"'));
  await page.waitForTimeout(3500);
  const state = await page.evaluate(() => ({
    balance: document.getElementById('balance')?.textContent ?? '',
    notice: document.getElementById('notice')?.textContent ?? '',
    plans: document.querySelectorAll('.plan').length,
    rows: document.querySelectorAll('#days .order, #orders .order').length,
  }));
  if (TOKEN === '') {
    console.log(`      （没给 DSH_E2E_EMAIL，只验渲染）${JSON.stringify(state)}`);
  } else {
    const signedOut = /未登录|Not signed in/.test(state.notice);
    check(`${path} 用桌面桥（Bearer）拿到数据，没有 cookie 也能用`,
      !signedOut && state.balance !== '' && state.balance !== '—', JSON.stringify(state));
    console.log(`      ${JSON.stringify(state)}`);
  }
  await page.screenshot({ path: join(SHOTS, `embedded${path.replace('/', '-')}.png`) }).catch(() => undefined);
}

/* 顺带把落地页也看一眼：它是流程终点，只有「成了没有」这一个信息 */
await page.goto(`${ACCOUNT}/dsh/authorized`, { waitUntil: 'domcontentloaded' });
const authorized = await page.content();
check('/dsh/authorized 渲染成功态并带品牌外壳',
  authorized.includes('data-page="authorized"') && authorized.includes('class="brand"'));
await page.screenshot({ path: join(SHOTS, 'authorized.png') }).catch(() => undefined);

await browser.close();
console.log(`\n截图：${SHOTS}`);
console.log(failed === 0 ? '[pages] 全部通过' : `[pages] ${String(failed)} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
