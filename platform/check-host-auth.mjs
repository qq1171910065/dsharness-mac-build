#!/usr/bin/env node
/**
 * 打真机验「共享密钥」这条服务端到服务端通道。
 *
 * 为什么必须打真机：单测（`host-auth.test.mjs`）只能证明**我们自己算出的
 * cookie 与官方算法一致**；「官方那条认证路径到底认不认它」只有把请求真的
 * 打进一个跑着的 harness 才知道 —— 而这一条恰恰是最容易错的（cookie 名、
 * 签名原文、过期窗口任一漂移都会 401）。
 *
 * 用法：
 *   1) 起一个 web profile，并且部署层已装、密钥已给：
 *        $env:DSH_HOME="$env:TEMP\dsh-auth"; $env:DSH_AUTH_TOKEN='<≥16 位>'
 *        node platform/install.mjs
 *        node apps/cli/lib/bin.js web --port 13096 --no-open
 *   2) 验：
 *        $env:DSH_AUTH_TOKEN='<同一个密钥>'; node platform/check-host-auth.mjs
 *
 * 退出码 0 = 全过；1 = 有断言失败；2 = 没给密钥（不是失败，是没验）。
 * **不打印密钥内容**，只打印长度。
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const BASE = String(process.env.DSH_AUTH_BASE || 'http://127.0.0.1:13096').replace(/\/+$/, '');
const TOKEN = String(process.env.DSH_AUTH_TOKEN || '').trim();
const COOKIE_NAME = String(process.env.DSH_AUTH_COOKIE || 'dsharness_auth');

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

if (TOKEN.length < 16) {
  console.log('[SKIP] 需要 DSH_AUTH_TOKEN（≥16 位，与 server 启动时用的是同一个）');
  process.exit(2);
}

/** 一次 unary RPC；`session/list` 是各 profile 都有的只读端点。 */
async function rpc(headers) {
  const response = await fetch(`${BASE}/api/session/list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { _request: {} } },
    }),
  });
  let body = null;
  try { body = await response.json(); } catch { /* 非 JSON（401 的纯文本） */ }
  return { status: response.status, body };
}

/* 1. 没有凭证：官方的连接鉴权拒绝（本插件不该替它放行） */
const none = await rpc({});
check('无凭证 → 401', none.status === 401, `status=${none.status}`);

/* 2. 错密钥：同样拒绝。这一条同时证明「比较不是恒真」 */
const wrong = await rpc({ authorization: `Bearer ${'x'.repeat(Math.max(24, TOKEN.length))}` });
check('错密钥 → 401', wrong.status === 401, `status=${wrong.status}`);

/* 3. 短密钥也不该被当成密钥（下限是 16 位） */
const short = await rpc({ authorization: 'Bearer short' });
check('短密钥 → 401', short.status === 401, `status=${short.status}`);

/* 4. 正确密钥：进得了官方 RPC 面，而且拿到的是**真响应**（ok 字段存在） */
const right = await rpc({ authorization: `Bearer ${TOKEN}` });
check('正确密钥 → 200', right.status === 200, `status=${right.status}`);
check('响应是官方 RPC 信封（不是中间件的拦截页）',
  right.body?.type === 'server-response' && right.body?.result !== undefined,
  JSON.stringify(right.body ?? {}).slice(0, 120));

/* 5. 登录页：局域网里的浏览器用密钥换 cookie */
const loginPage = await fetch(`${BASE}/dsharness/auth`);
const html = await loginPage.text();
check('登录页 200 + HTML', loginPage.status === 200 && html.includes('<form'), `status=${loginPage.status}`);

const login = await fetch(`${BASE}/dsharness/auth`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }),
});
const setCookie = login.headers.getSetCookie?.() ?? [];
check('登录页换取 cookie', login.status === 200 && setCookie.some((value) => value.startsWith(`${COOKIE_NAME}=`)),
  `status=${login.status} cookies=${String(setCookie.length)}`);
const cookie = setCookie.find((value) => value.startsWith(`${COOKIE_NAME}=`))?.split(';')[0] ?? '';

const wrongLogin = await fetch(`${BASE}/dsharness/auth`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'not-the-secret' }),
});
check('登录页拒绝错密钥', wrongLogin.status === 401, `status=${wrongLogin.status}`);

/* 6. cookie 也能过 RPC（浏览器那条路） */
if (cookie !== '') {
  const viaCookie = await rpc({ cookie });
  check('cookie 也能过 /api', viaCookie.status === 200, `status=${viaCookie.status}`);
}

/* 7. 首页：带 cookie 能开（页面本身的认证走 authorizeIndex，与 /api 不是同一条） */
const indexNoAuth = await fetch(`${BASE}/`, { redirect: 'manual' });
check('首页无凭证 → 401', indexNoAuth.status === 401, `status=${indexNoAuth.status}`);
if (cookie !== '') {
  const indexAuth = await fetch(`${BASE}/`, { headers: { cookie } });
  const indexHtml = await indexAuth.text();
  check('首页带 cookie → 200 且是 DSH 页面',
    indexAuth.status === 200 && indexHtml.includes('__DSH_BOOT_READY__'),
    `status=${indexAuth.status} bytes=${String(indexHtml.length)}`);
}

/* 8. 升级握手：实时数据那条腿（`/api/remote.mux` 是 WebSocket） */
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { WebSocket } = require('ws');
const { origin } = new URL(BASE);
const wsUrl = `${BASE.replace(/^http/, 'ws')}/api/remote.mux`;

function mux(headers) {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl, { headers, origin });
    const timer = setTimeout(() => { socket.terminate(); resolve('timeout') }, 12_000);
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'open', streamId: randomUUID(), endpoint: 'account/watch', payload: { args: {} },
      }));
    });
    socket.on('message', (raw) => {
      clearTimeout(timer); socket.close();
      resolve(raw.toString('utf8').includes('"type":"item"') ? 'data' : 'frame');
    });
    socket.on('unexpected-response', (_req, res) => { clearTimeout(timer); socket.terminate(); resolve(`http ${res.statusCode}`); });
    socket.on('error', (error) => { clearTimeout(timer); resolve(`error ${error.message}`); });
  });
}

check('mux 无凭证 → 401', (await mux({})) === 'http 401');
check('mux 错密钥 → 401', (await mux({ Authorization: 'Bearer definitely-wrong-secret-32' })) === 'http 401');
check('mux 正确密钥 → 握手通过并收到数据帧', (await mux({ Authorization: `Bearer ${TOKEN}` })) === 'data');

console.log(
  failed === 0
    ? `\n[host-auth] 全部通过（base=${BASE}，密钥长度 ${String(TOKEN.length)}）`
    : `\n[host-auth] ${String(failed)} 项失败`
);
process.exitCode = failed === 0 ? 0 : 1;
