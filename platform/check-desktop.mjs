#!/usr/bin/env node
/**
 * 桌面端真机验收：连到**真实 Electron** 的渲染进程，验证
 * 「官方登录全部对接 Platform」+ 官方余额显示，以及 host-auth 插件在桌面 profile 下生效。
 *
 * ## 为什么必须单独验，不能拿 web 那套代替
 *
 * `server/scripts/web-login-e2e.mjs` 跑在纯浏览器里，它**要注入** `dshDesktop`
 * 标记，因为上游把整套账号 UI 挂在那个标记上而浏览器没有它。桌面壳的 preload
 * **自己**注入真标记（含 `browser` / `deviceInfo` / `keyboard` / `shortcuts` / `updates`），
 * 所以这里验的是真实那一份，而不是夹具。本脚本会把「标记存在且带这些键」也断言进去。
 *
 * ## 怎么连
 *
 * `pnpm run start:desktop` 用 `--remote-debugging-port=9222` 起 Electron
 * （`apps/desktop/scripts/dev.ts`），本脚本走 CDP 接上去。页面是
 * `dsh-app://app/`，**不是 HTTP 源**；Host 的回环地址在渲染层的
 * `__DSH_TRANSPORT__.streamBaseUrl` 里（`apps/desktop/src/main.ts` 注入）。
 *
 * ## ⚠️ 两个环境陷阱（实测踩到）
 *
 * 1. **`ELECTRON_RUN_AS_NODE` 必须清掉**。在 DSH 自己里面跑 `pnpm run dev:desktop`
 *    时，这个变量已经存在于环境里，`electron.exe` 会按纯 Node 跑并拒绝
 *    `--remote-debugging-port` / `--user-data-dir`，报 `bad option`。要
 *    `Remove-Item Env:\ELECTRON_RUN_AS_NODE`（或在新终端里跑）。
 * 2. **CDP 下 `context.newPage()` 不被支持**（`Target.createTarget: Not supported`）。
 *    所以本脚本不开新标签页：登录那一步直接打 HTTP（与 `server/scripts/e2e.mjs`
 *    同一条路径），页面只用来看与操作现有那一个。
 *
 * ## 前置
 *
 * ```powershell
 * # 1) 本产品 server
 * cd server; npm run dev
 * # 2) 装部署层到桌面端的 home，然后起桌面端
 * cd client
 * $env:DSH_HOME="$env:TEMP\dsh-desktop-dev"
 * $env:DSH_PLATFORM_ORIGIN='http://127.0.0.1:13090'
 * $env:DSH_AUTH_TOKEN='<≥16 位>'
 * node platform/install.mjs
 * Remove-Item Env:\ELECTRON_RUN_AS_NODE
 * pnpm run start:desktop
 * # 3) 验
 * $env:DSH_E2E_EMAIL='<本产品库里已有的用户邮箱>'
 * node platform/check-desktop.mjs
 * ```
 *
 * 退出码 0 = 全过；1 = 有断言失败。
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CDP = process.env.DSH_DESKTOP_CDP || 'http://127.0.0.1:9222';
const EMAIL = String(process.env.DSH_E2E_EMAIL || '');
const TOKEN = String(process.env.DSH_AUTH_TOKEN || '').trim();
const SHOTS = process.env.DSH_SHOT_DIR || resolve('C:/Users/ai/Documents/CODE/02products/dsharness/docs/images');
const CLIENT_DIR = resolve(import.meta.dirname, '..');
const SERVER_DIR = resolve(CLIENT_DIR, '..', 'server');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** playwright-core 只在 client 的 pnpm store 里（apps/web 的 devDependency 未提升）。 */
async function loadChromium() {
  const store = resolve(CLIENT_DIR, 'node_modules', '.pnpm');
  const dir = readdirSync(store).filter((name) => /^playwright-core@\d/.test(name)).sort().pop();
  if (dir === undefined) throw new Error(`playwright-core is not installed under ${store}`);
  return import(pathToFileURL(resolve(store, dir, 'node_modules', 'playwright-core', 'index.mjs')).href);
}

/** 用既有的本地用户签一份会话（不发邮件），拿到 token。 */
function mintSession() {
  /*
   * 走 server 自己那个 CLI 入口（`node scripts/local-session.mjs`）而不是
   * 内联 tsx 参数：入口是稳定的，加载器怎么配是那边的实现细节。
   * Windows 上用 `npx.cmd`，避免 `shell: true` 的转义与弃用告警。
   */
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const output = execFileSync(npx, ['tsx', 'scripts/local-session.mjs', '--email', EMAIL], {
    cwd: SERVER_DIR, encoding: 'utf8',
  });
  return JSON.parse(output);
}

const { chromium } = await loadChromium();
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.connectOverCDP(CDP);
const contexts = browser.contexts();
check('连上桌面壳的渲染进程', contexts.length > 0, `${String(contexts.length)} 个 context`);
if (contexts.length === 0) { await browser.close(); process.exit(1); }

const pages = contexts.flatMap((context) => context.pages());
const page = pages.find((candidate) => candidate.url().startsWith('dsh-app://')) ?? pages[0];
check('找到桌面 UI 页面（dsh-app://）', page !== undefined && page.url().startsWith('dsh-app://'), page?.url());
if (page === undefined) { await browser.close(); process.exit(1); }

/** 桌面壳自己注入的标记 —— 这是本脚本与 web 那套的分界点。 */
const marker = await page.evaluate(() => {
  const value = globalThis.dshDesktop;
  return value === undefined ? null : { protocolVersion: value.protocolVersion ?? null, keys: Object.keys(value) };
});
check('桌面壳**自己**注入了 dshDesktop（不是测试夹具）',
  marker !== null && marker.keys.includes('browser') && marker.keys.includes('deviceInfo'),
  JSON.stringify(marker));

/** 渲染层拿到的 Host 回环地址（页面不是 HTTP 源，只能从这里取）。 */
const origin = await page.evaluate(() => globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? null);
check('渲染层拿到了 Host 回环地址', typeof origin === 'string' && origin.startsWith('http://127.0.0.1:'), String(origin));

const cookies = (await contexts[0].cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
async function call(method, args = {}) {
  const response = await contexts[0].request.post(`${origin}/api/${method}`, {
    headers: { 'content-type': 'application/json', cookie: cookies },
    data: { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } },
  });
  const text = await response.text();
  /*
   * 桌面 Host 上 `/api/<不在本进程服务图里的端点>` 会回 **404「not found」**
   * （纯文本，不是 JSON）。`cancelSignIn` 就是这种：`startSignIn` 由
   * `account-controller` 提供，而取消要走的门面在桌面 Host 的图里没被挂。
   * 所以这里**不假设每个方法都可用**，而是把「不可用」如实报给调用方。
   */
  let body;
  try { body = JSON.parse(text); } catch {
    return { error: `${method}: HTTP ${String(response.status())} ${text.slice(0, 60)}` };
  }
  if (body?.result?.ok !== true) return { error: `${method}: ${JSON.stringify(body).slice(0, 200)}` };
  return { value: body.result.value };
}

/**
 * 读一次账号状态。
 *
 * `account/getState` / `startSignIn` 由桌面 Host 的 `account-controller` 提供；
 * 返回 `{ value }` 或 `{ error }`，由调用方决定「不可用」算失败还是跳过。
 */
async function state() {
  const result = await call('account/getState');
  if (result.error !== undefined) throw new Error(result.error);
  return result.value;
}

let view = await state();
check('桌面壳里账号协议面可用', view.status === 'signed-out' || view.status === 'credential-stored', view.status);
check('两个跳转链接指向本产品 server（而不是 platform.deepseek.com）',
  view.links.usageUrl.includes('13090') && view.links.topUpUrl.includes('13090'),
  `${view.links.usageUrl} / ${view.links.topUpUrl}`);
console.log(`  账号状态: ${view.status}  attempt=${view.attempt?.phase ?? 'null'}`);
await page.screenshot({ path: join(SHOTS, 'desktop-01-chat.png') });

/* 官方那两个链接必须真的可解析（302 到网关），否则账号页点它们是 404 */
for (const key of ['usageUrl', 'topUpUrl']) {
  const response = await contexts[0].request.get(view.links[key], { maxRedirects: 0 });
  check(`账号页链接 ${key} 不是 404`, response.status() === 302, `status=${String(response.status())}`);
}

const identity = { version: '0.2.1-alpha.1', locale: 'zh-CN', timezoneOffsetSeconds: 28800 };

if (view.status !== 'credential-stored' && EMAIL !== '') {
  /*
   * 桌面壳未登录时会**自己**发起登录（引导页），这本身就是「官方所有登录
   * 都对接 Platform」在桌面端最强的一条证据：authorizeUrl 必须指向本产品
   * server，而不是 platform.deepseek.com。
   *
   * `startSignIn` 对**进行中**的尝试是幂等的：上游
   * `deepseek-account-platform/src/index.ts:407` 遇到
   * initializing/waiting-browser/exchanging/committing 就返回现状，
   * 其余阶段会等上一个 `done` 再新建 —— 所以可以直接再调一次，
   * 不必先 cancel（cancel 之后 attempt 仍非 null，那样反而永远发不出新的）。
   */
  const started = await call('account/startSignIn', { client: identity, callbackOrigin: origin, loginSource: 'desktop' });
  if (started.error !== undefined) console.log(`[NOTE] startSignIn: ${started.error}`);
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(250);
    view = await state();
    if (view.attempt?.authorizeUrl !== undefined || view.status === 'credential-stored') break;
  }
  const authorizeUrl = String(view.attempt?.authorizeUrl ?? '');
  check('桌面端发起的登录指向本产品 server',
    authorizeUrl.startsWith('http://127.0.0.1:13090/dsh/authorize'), authorizeUrl);
  await page.screenshot({ path: join(SHOTS, 'desktop-02-signin-dialog.png') });

  if (authorizeUrl === '') {
    console.log(`[SKIP] 登录段：没拿到 authorizeUrl（phase=${String(view.attempt?.phase)}）`);
  } else {
    const stateParam = new URL(authorizeUrl).searchParams.get('state');
    const minted = mintSession();
    check('按既有用户签发本地会话（不发邮件）', typeof minted.token === 'string' && minted.user.id > 0,
      `user=${minted.user.username} id=${String(minted.user.id)}`);

    /* 授权页那一半：页面自己在完成登录后会打这个端点；这里等价地打一次。 */
    const complete = await contexts[0].request.post('http://127.0.0.1:13090/dsh/authorize/complete', {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.token}` },
      data: { state: stateParam },
    });
    const completed = await complete.json();
    check('换到回环回调地址', complete.status() === 200 && typeof completed.redirectUrl === 'string',
      JSON.stringify(completed).slice(0, 140));

    if (typeof completed.redirectUrl === 'string') {
      /* 回调落回**桌面 Host**的回环端口 —— 由官方 provider 自己完成 exchange。 */
      const callback = await contexts[0].request.get(completed.redirectUrl, { maxRedirects: 0 });
      check('回调被官方 provider 接受', callback.status() < 400, `status=${String(callback.status())}`);
    }

    for (let i = 0; i < 60 && view.status !== 'credential-stored'; i += 1) {
      await page.waitForTimeout(500);
      view = await state();
    }
    check('桌面壳账号状态 = credential-stored', view.status === 'credential-stored', view.status);
  }
} else if (EMAIL === '') {
  console.log('[SKIP] 登录段：需要 DSH_E2E_EMAIL（本产品库里已有的用户邮箱）');
}

if (view.status === 'credential-stored') {
  /*
   * 官方 RPC 的回包是 `{ status: 'ready', value: <内容> }` —— 一层
   * `RemoteResult` 信封（`{status,value}` 或 `{status:'failed',error}`），
   * 不是直接的值。实测踩到：第一版按 `profile.value.name` 读，拿到的是
   * 外层信封，永远 undefined。
   */
  const profile = await call('account/getProfile', { client: identity });
  check('桌面壳拿到本产品资料', profile.value?.status === 'ready'
    && typeof profile.value.value?.name === 'string', JSON.stringify(profile).slice(0, 170));

  const balance = await call('account/getBalance', { client: identity });
  check('桌面壳拿到余额数组', balance.value?.status === 'ready' && Array.isArray(balance.value.value),
    JSON.stringify(balance).slice(0, 200));
  check('余额是十进制字符串（官方 zod 要求）',
    typeof balance.value?.value?.[0]?.balance === 'string', JSON.stringify(balance.value?.value?.[0]));
}

/*
 * 设置 → 账号与余额（官方快捷键；面板没有 role=dialog）。
 *
 * 面板可能是**上一次运行留下**的其它分区，所以先按 Esc 收起来再打开，
 * 否则会读到「自动化任务」那种残留视图（实测踩到）。
 *
 * ⚠️ 桌面壳在**首次登录后**会弹官方 onboarding 整页引导（「开始设置」），
 * 它盖住一切、**不是** `role=dialog`、而且分步（欢迎 → 额度 → 用途 → 过程）。
 * 退出它的路径随**当前步**变化（`DesktopOnboarding.tsx`）：
 *
 * - 欢迎步根本没有跳过键（`step !== 'welcome'` 才渲染，:115-118）⇒ 先「开始设置」；
 * - 额度步点「跳过」弹的是 `credit-skip` 确认框，其**左键是「我知道了」**
 *   （`onboardingUnderstood` → `onSkip`），右键才是「去充值」；
 * - 其余步点「跳过」弹 `skip` 确认框，左键「继续设置」、右键「进入应用」。
 *
 * 所以不去猜顺序，而是**循环点到引导元素消失**为止。少点一步就会停在
 * 引导页或确认框上，后面读到的全是引导文本 —— 第一版就是这么误判
 * 「账号页没渲染」的。
 */
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

/**
 * 元素是否真的可见。
 *
 * ⚠️ 两个都不能用，各踩过一次：
 * - `offsetParent !== null` —— 覆盖层是 `position: fixed`，固定定位元素的
 *   `offsetParent` **恒为 null**，于是屏幕上明明有「跳过」，脚本报「没有可点的键」；
 * - `checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })` ——
 *   这些选项把**内容可见性**也算进去，在 Electron 里对这两个按钮返回 false
 *   （它们的 `display`/`visibility`/`opacity` 全是正常值，见实测 dump）。
 *
 * 用几何尺寸 + 未 disabled 判定：这正是「能被点到」的定义。判定**内联**在
 * 每个 `evaluate` 里，不通过字符串 eval 传进去 —— 那样在页面上下文里容易
 * 因为作用域/CSP 静默失效（也踩过一次）。
 */
function pickVisible(labels) {
  return page.evaluate((wanted) => {
    const hit = [...document.querySelectorAll('button,a,[role=button]')].find((node) => {
      if (node.disabled === true) return false
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      return wanted.includes((node.textContent || '').trim())
    })
    if (hit === undefined) return null
    hit.click()
    return (hit.textContent || '').trim()
  }, labels)
}

/** 一次点击尝试；返回点了什么（没得点返回 null）。 */
const clickByText = pickVisible;

/** 当前有没有一个可见的确认框（`Modal` 的 `role=dialog`）。 */
async function dialogVisible() {
  return page.evaluate(() => [...document.querySelectorAll('[role=dialog]')].some((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }));
}

/** 引导是否还在页面上（它给 section 打了 `data-desktop-onboarding`）。 */
async function onboardingVisible() {
  return page.evaluate(() => [...document.querySelectorAll('[data-desktop-onboarding]')].some((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }));
}

/*
 * 确认框里优先「退出类」的两键，**先于**页面上的「跳过」。
 *
 * 第一版按固定顺序试（跳过 → 我知道了 → 进入应用），结果「跳过」在确认框
 * 后面**仍然可见**，于是每一轮都点它、确认框永远重开，8 轮后还在原地。
 * 顺序必须体现「确认框是当前前台」这件事。
 */
const DIALOG_LABELS = [['我知道了', 'Got it'], ['进入应用', 'Open app']];
const PAGE_LABELS = [['开始设置', 'Start setup'], ['跳过', 'Skip']];

for (let round = 0; round < 10 && await onboardingVisible(); round += 1) {
  const inDialog = await dialogVisible();
  const candidates = inDialog ? [DIALOG_LABELS, PAGE_LABELS] : [PAGE_LABELS];
  let clicked = null;
  for (const labels of candidates) {
    clicked = await clickByText(labels);
    if (clicked !== null) break;
  }
  console.log(`  引导第 ${String(round + 1)} 步（${inDialog ? '确认框' : '引导页'}）: `
    + `${clicked === null ? '(没有可点的键)' : `点了「${clicked}」`}`);
  if (clicked === null) break;
  await page.waitForTimeout(1800);
}
check('退出官方 onboarding 引导', !(await onboardingVisible()));

await page.keyboard.press('Escape');
await page.waitForTimeout(600);

/*
 * 打开「设置 → 账号与余额」。
 *
 * ⚠️ 实测的正确路径：先点侧栏 `button[aria-label="账号菜单"]`，再点菜单里
 * 那个 `role=menuitem`。两处都不能按精确文本找：
 *   - 侧栏那个按钮的**文本是用户名**（「cloud233」），不是「设置」；
 *   - 菜单项的文本是 **「设置Ctrl+,」**（快捷键拼在同一个节点里），
 *     精确等于「设置」永远匹配不上。
 * `Control+Alt+Comma` 在这台机器上也没打开面板（试过），所以走菜单这条路。
 */
const openedMenu = await page.evaluate(() => {
  const trigger = [...document.querySelectorAll('button')]
    .find((node) => (node.getAttribute('aria-label') || '') === '账号菜单');
  if (trigger === undefined) return null;
  trigger.click();
  return '账号菜单';
});
check('点开官方账号菜单', openedMenu !== null);
await page.waitForTimeout(1200);

const openedSettings = await page.evaluate(() => {
  const item = [...document.querySelectorAll('[role=menuitem]')]
    .find((node) => (node.textContent || '').trim().startsWith('设置'));
  if (item === undefined) return null;
  item.click();
  return (item.textContent || '').trim();
});
check('从账号菜单进入设置', openedSettings !== null, String(openedSettings));
await page.waitForTimeout(3000);
/**
 * 当前可见的叶子文本。
 *
 * ⚠️ 用几何尺寸判定，不用 `offsetParent`：桌面壳里大量覆盖层是
 * `position: fixed`，它们的 `offsetParent` 恒为 null（实测踩到，
 * 会把整块界面读成「不可见」）。
 */
async function visibleLabels() {
  return page.evaluate(() => [...document.querySelectorAll('*')]
    .filter((node) => {
      if (node.children.length > 0) return false
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    .map((node) => (node.textContent || '').trim()).filter(Boolean));
}

const labels = await visibleLabels();
check('设置面板里有「账号与余额」分区', labels.some((label) => label.includes('账号与余额')),
  JSON.stringify(labels.slice(-14)));
await page.evaluate(() => {
  const hit = [...document.querySelectorAll('*')].find((node) => {
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    return /账号与余额/.test((node.getAttribute('aria-label') || node.textContent || '').trim())
  })
  hit?.click()
});
await page.waitForTimeout(3000);
await page.screenshot({ path: join(SHOTS, 'desktop-03-account-balance.png') });
const panel = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
check('账号页在桌面壳里渲染出来了', /账号与余额|充值余额|赠金余额/.test(panel), panel.slice(-180));
check('面板里没有旧壳的用量/费用统计', !/用量与花费|费用统计/.test(panel));
console.log('  面板尾部:', panel.slice(-220));

/* host-auth：桌面 Host 上同一条服务端到服务端通道（有密钥才验） */
if (TOKEN.length >= 16) {
  const hostOrigin = new URL(origin).origin;
  /*
   * ⚠️ 这两发必须用**裸 fetch**，不能用 `contexts[0].request`：
   * 后者的 cookie 罐里就有 Electron 渲染层那份 `dsh-auth-*` 连接 cookie，
   * 于是「无凭证」那一发实际上带着凭证，永远 200 —— 实测踩到，
   * 看起来像「门禁失效」，其实是量错了对象。
   */
  const rpc = (headers) => fetch(`${hostOrigin}/api/session/list`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } },
    }),
  });
  const noAuth = await rpc({});
  check('桌面 Host 的 /api 无凭证 → 401（裸 fetch，不带渲染层 cookie）',
    noAuth.status === 401, `status=${String(noAuth.status)}`);
  const wrongAuth = await rpc({ authorization: `Bearer ${'x'.repeat(32)}` });
  check('桌面 Host 的 /api 错密钥 → 401', wrongAuth.status === 401, `status=${String(wrongAuth.status)}`);
  const withAuth = await rpc({ authorization: `Bearer ${TOKEN}` });
  check('桌面 Host 的 /api 带共享密钥 → 200', withAuth.status === 200, `status=${String(withAuth.status)}`);
  if (withAuth.status === 200) {
    const body = await withAuth.json();
    check('桌面 Host 上共享密钥拿到真 RPC 信封', body?.result?.ok === true, JSON.stringify(body).slice(0, 130));
  }
  const indexNoAuth = await fetch(`${hostOrigin}/`, { redirect: 'manual' });
  check('桌面 Host 首页无凭证 → 401', indexNoAuth.status === 401, `status=${String(indexNoAuth.status)}`);
} else {
  console.log('[SKIP] host-auth 段：需要 DSH_AUTH_TOKEN');
}

await browser.close();
console.log(failed === 0 ? '\n[desktop] 全部通过' : `\n[desktop] ${String(failed)} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
