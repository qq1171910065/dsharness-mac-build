import { strict as assert } from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  MIN_TOKEN_LENGTH,
  PUBLIC_PATHS,
  STATUS_JSON_PATH,
  STATUS_PATH,
  appendCookie,
  cookieValue,
  decodeStoredSecret,
  encodeBase64Url,
  connectionCookieName,
  escapeHtml,
  gatewayPageHtml,
  isLoopbackHostname,
  mintConnectionCookie,
  name,
  offHostPageHtml,
  presentedSecret,
  requestAuthority,
  resolveConfig,
  safeEqualString,
  sendJson,
} from './host-auth.mjs';

/**
 * `host-auth.mjs` 的纯函数面。
 *
 * 这个插件让「共享密钥」等价于「官方的连接 cookie」，所以两件事必须钉住：
 *
 * 1. **密钥比较不能有捷径** —— 长度不同也必须走完 `timingSafeEqual`；
 * 2. **铸出来的 cookie 必须与官方 `packages/client/connection/src/browser-auth.ts`
 *    的格式逐字节一致** —— 它才是官方认证逻辑真正读的东西。
 *
 * 第 2 条这里用**独立重算**验证（不调用插件自己的函数再比），否则写错了两边
 * 一起错、测试照样绿。真正「官方能不能认」由 `check-host-auth.mjs` 打真机验。
 */

test('插件名稳定（fiber 标识与 dispose 归属都靠它）', () => {
  assert.equal(name, 'dsharness-host-auth');
});

test('resolveConfig：声明过但太短的密钥会被换掉，并被标记出来', () => {
  /*
   * 太短的密钥**此前等于整条通道关闭**（`enabled: false`），所以不会有任何调用方
   * 依赖它；换一把强的不会破坏谁，而「通道悄悄不工作」正是用户报的那类问题。
   * 换掉这件事必须可诊断，所以 `rejectedDeclared` 单独标出来给 `apply` 记 warn。
   */
  const short = resolveConfig({ token: 'x'.repeat(MIN_TOKEN_LENGTH - 1) }, () => 'G'.repeat(43));
  assert.equal(short.token, 'G'.repeat(43));
  assert.equal(short.generated, true);
  assert.equal(short.rejectedDeclared, true);
  assert.equal(short.enabled, true);
  // 够长的就原样使用，且不算「被换掉」。
  const ok = resolveConfig({ token: 'x'.repeat(MIN_TOKEN_LENGTH) }, () => 'H'.repeat(43));
  assert.equal(ok.token, 'x'.repeat(MIN_TOKEN_LENGTH));
  assert.equal(ok.generated, false);
  assert.equal(ok.rejectedDeclared, false);
});

test('resolveConfig：关掉这条通道用 enabled，不用空密钥', () => {
  /*
   * 部署行是 `token: !!js process.env.DSH_AUTH_TOKEN ?? ''`，也就是**总是**给出
   * `token` 键（未设置时是空串）。所以「显式空串＝关掉」这条老口径已经不可能
   * 表达意图 —— 唯一的开关是 `enabled: false`，而空串按「未配置」处理并生成。
   */
  const saved = process.env.DSH_AUTH_TOKEN;
  delete process.env.DSH_AUTH_TOKEN;
  try {
    const off = resolveConfig({ token: '', enabled: false }, () => 'I'.repeat(43));
    assert.equal(off.enabled, false);
    const unconfigured = resolveConfig({ token: '' }, () => 'J'.repeat(43));
    assert.equal(unconfigured.enabled, true);
    assert.equal(unconfigured.token, 'J'.repeat(43));
  } finally {
    if (saved === undefined) delete process.env.DSH_AUTH_TOKEN;
    else process.env.DSH_AUTH_TOKEN = saved;
  }
});

test('resolveConfig：环境变量是种子，显式配置优先', () => {
  const saved = process.env.DSH_AUTH_TOKEN;
  process.env.DSH_AUTH_TOKEN = 'env-seeded-secret-16chars';
  try {
    assert.equal(resolveConfig({}).token, 'env-seeded-secret-16chars');
    assert.equal(resolveConfig({ token: 'explicit-secret-16chars' }).token, 'explicit-secret-16chars');
    // 环境变量够了就不生成。
    assert.equal(resolveConfig({}, () => 'K'.repeat(43)).generated, false);
  } finally {
    if (saved === undefined) delete process.env.DSH_AUTH_TOKEN;
    else process.env.DSH_AUTH_TOKEN = saved;
  }
});

test('resolveConfig：显式 enabled=false 时密钥再长也不启用', () => {
  assert.equal(resolveConfig({ enabled: false, token: 'x'.repeat(40) }).enabled, false);
});

test('resolveConfig：没有密钥时自动生成一把并持久化（「装好就能对接」）', () => {
  /*
   * 用户口径：「网关插件要能显示端口和令牌，否则我无法对接」——「显示」的前提是
   * **真的有一把令牌**。此前默认态是 `token: ''` ⇒ `enabled: false` ⇒ 插件整体
   * 不挂载 ⇒ 既没有通道也没有可显示的东西。
   *
   * 所以未配置密钥时生成一把随机值（43 字符 base64url，远高于 MIN_TOKEN_LENGTH），
   * 由 `apply` 写进凭据层；生成的值必须每次不同，且不能是任何写死的常量。
   */
  const a = resolveConfig({}, () => 'A'.repeat(43));
  const b = resolveConfig({}, () => 'B'.repeat(43));
  assert.equal(a.enabled, true);
  assert.equal(a.token, 'A'.repeat(43));
  assert.notEqual(a.token, b.token, '自动生成的令牌必须每次不同');
  assert.ok(a.token.length >= MIN_TOKEN_LENGTH);
  // 显式给的值永远优先，且不会被生成覆盖。
  assert.equal(resolveConfig({ token: 'explicit-secret-16chars' }, () => 'C'.repeat(43)).token, 'explicit-secret-16chars');
  // enabled:false 仍然是「关掉这条通道」，不受生成影响。
  assert.equal(resolveConfig({ enabled: false }, () => 'D'.repeat(43)).enabled, false);
  assert.equal(resolveConfig({ enabled: false }, () => 'D'.repeat(43)).token, 'D'.repeat(43));
});

test('resolveConfig：环境变量给的密钥仍然优先于自动生成', () => {
  const saved = process.env.DSH_AUTH_TOKEN;
  process.env.DSH_AUTH_TOKEN = 'env-seeded-secret-16chars';
  try {
    assert.equal(resolveConfig({}, () => 'E'.repeat(43)).token, 'env-seeded-secret-16chars');
  } finally {
    if (saved === undefined) delete process.env.DSH_AUTH_TOKEN;
    else process.env.DSH_AUTH_TOKEN = saved;
  }
});

test('resolveConfig：cookie 名与代铸有效期有安全默认', () => {
  const config = resolveConfig({ token: 'x'.repeat(40) });
  assert.equal(config.cookieName, 'dsharness_auth');
  // 官方连接层会拒绝超过它自己 cookieMaxAgeDays 的 cookie；代铸值必须足够短
  assert.ok(config.cookieMaxAgeSec > 0 && config.cookieMaxAgeSec <= 24 * 3600, '代铸有效期必须是短命值');
  assert.equal(resolveConfig({ token: 'x'.repeat(40), cookieMaxAgeSec: 0 }).cookieMaxAgeSec, config.cookieMaxAgeSec);
  assert.equal(resolveConfig({ token: 'x'.repeat(40), cookieMaxAgeSec: 'abc' }).cookieMaxAgeSec, config.cookieMaxAgeSec);
  assert.equal(resolveConfig({ token: 'x'.repeat(40), cookieMaxAgeSec: 120 }).cookieMaxAgeSec, 120);
});

test('safeEqualString：相等才真，且长度不同不提前返回', () => {
  assert.equal(safeEqualString('abc', 'abc'), true);
  assert.equal(safeEqualString('abc', 'abd'), false);
  assert.equal(safeEqualString('abc', 'abcd'), false);
  assert.equal(safeEqualString('', ''), true);
  assert.equal(safeEqualString(undefined, 'x'), false);
});

test('presentedSecret：认 Bearer，大小写与空白宽容', () => {
  const request = (authorization) => ({ headers: { authorization } });
  assert.equal(presentedSecret(request('Bearer secret-16-chars-long')), 'secret-16-chars-long');
  assert.equal(presentedSecret(request('bearer secret-16-chars-long')), 'secret-16-chars-long');
  assert.equal(presentedSecret(request('BEARER   secret-16-chars-long  ')), 'secret-16-chars-long');
  assert.equal(presentedSecret(request('Bearer ')), undefined);
  assert.equal(presentedSecret(request('Basic secret-16-chars-long')), undefined);
  assert.equal(presentedSecret(request(undefined)), undefined);
});

test('presentedSecret：没有 Bearer 时退回本插件自己的 cookie', () => {
  const request = { headers: { cookie: 'a=1; dsharness_auth=from-cookie-16chars; b=2' } };
  assert.equal(presentedSecret(request), 'from-cookie-16chars');
  // Bearer 优先于 cookie（脚本用头、浏览器用 cookie，两者同时带时以头为准）
  const both = { headers: { authorization: 'Bearer from-header-16chars', cookie: 'dsharness_auth=from-cookie-16chars' } };
  assert.equal(presentedSecret(both), 'from-header-16chars');
});

test('cookieValue：只认具名 cookie，不做通用解码', () => {
  assert.equal(cookieValue('a=1; target=v; b=2', 'target'), 'v');
  assert.equal(cookieValue('target=v', 'target'), 'v');
  assert.equal(cookieValue('a=target=v', 'target'), undefined, '不能拿值里的同名字段冒充');
  assert.equal(cookieValue('', 'target'), undefined);
  assert.equal(cookieValue(undefined, 'target'), undefined);
});

test('requestAuthority：只接受能解析的 authority', () => {
  assert.equal(requestAuthority({ host: '127.0.0.1:3080' }), '127.0.0.1:3080');
  assert.equal(requestAuthority({ host: 'DSH.Internal' }), 'dsh.internal');
  assert.equal(requestAuthority({}), undefined);
  assert.equal(requestAuthority({ host: '' }), undefined);
  assert.equal(requestAuthority({ host: 'a b' }), undefined);
});

test('isLoopbackHostname：回环三种写法', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '::1']) {
    assert.equal(isLoopbackHostname(host), true, host);
  }
  assert.equal(isLoopbackHostname('10.0.0.5'), false);
});

test('encodeBase64Url：无填充、URL 安全', () => {
  assert.equal(encodeBase64Url(Buffer.from('a')), 'YQ');
  assert.equal(encodeBase64Url(Buffer.from([0xfb, 0xff])), '-_8');
  assert.ok(!/[+/=]/.test(encodeBase64Url(Buffer.from('anything longer'))));
});

test('mintConnectionCookie：与官方 browser-auth 的格式逐字节一致', () => {
  const secret = Buffer.alloc(32, 7);
  const authority = '127.0.0.1:3080';
  const now = 1_800_000_000_000;
  const { name: cookieName, value } = mintConnectionCookie(authority, secret, 3600, now);

  // 独立重算官方那两处：cookie 名 = 前缀 + base64url(sha256(authority))
  const expectedName = 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(authority).digest());
  assert.equal(cookieName, expectedName);
  assert.equal(connectionCookieName(authority), expectedName);

  // 独立重算官方 encodeCookie：v1.<base64url(json)>.<base64url(hmacSha256(body))>
  const parts = value.split('.');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'v1');
  const body = parts[1];
  const expectedSignature = createHmac('sha256', secret).update(body).digest();
  assert.equal(parts[2], encodeBase64Url(expectedSignature));
  const payload = JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  assert.deepEqual(payload, { version: 1, authority, issuedAt: now, expiresAt: now + 3600 * 1000 });
});

test('mintConnectionCookie：不同 authority 铸出不同 cookie 名（绑定到主机）', () => {
  const secret = Buffer.alloc(32, 1);
  assert.notEqual(
    mintConnectionCookie('127.0.0.1:3080', secret, 60, 0).name,
    mintConnectionCookie('dsh.internal', secret, 60, 0).name,
  );
});

test('mintConnectionCookie：过期时间落在官方允许的窗口内', () => {
  const secret = Buffer.alloc(32, 3);
  const now = Date.now();
  const { value } = mintConnectionCookie('127.0.0.1:3080', secret, 3600, now);
  const payload = JSON.parse(Buffer.from(value.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  // 官方拒绝 expiresAt - issuedAt > cookieMaxAgeDays（默认 30 天）
  assert.ok(payload.expiresAt - payload.issuedAt <= 30 * 24 * 3600 * 1000);
  assert.ok(payload.expiresAt > payload.issuedAt);
});

test('appendCookie：追加而不覆盖调用方已有的 cookie', () => {
  const headers = { cookie: 'session=abc' };
  appendCookie(headers, { name: 'dsh-auth-x', value: 'v' });
  assert.equal(headers.cookie, 'session=abc; dsh-auth-x=v');
  const empty = {};
  appendCookie(empty, { name: 'n', value: 'v' });
  assert.equal(empty.cookie, 'n=v');
});

test('decodeStoredSecret：只接受官方的 grant 记录格式', () => {
  const raw = Buffer.alloc(32, 9);
  const valid = { kind: 'grant', payload: { version: 1, secret: encodeBase64Url(raw) } };
  assert.deepEqual(decodeStoredSecret(valid), raw);
  assert.equal(decodeStoredSecret(undefined), undefined);
  assert.equal(decodeStoredSecret({ kind: 'api-key', payload: { version: 1, secret: encodeBase64Url(raw) } }), undefined);
  assert.equal(decodeStoredSecret({ kind: 'grant', payload: { version: 2, secret: encodeBase64Url(raw) } }), undefined);
  assert.equal(decodeStoredSecret({ kind: 'grant', payload: { version: 1, secret: 'short' } }), undefined);
  assert.equal(decodeStoredSecret({ kind: 'grant', payload: null }), undefined);
});

/**
 * 「网关插件要能显示端口和令牌，否则我无法对接」——这一面就是那条要求的落点。
 *
 * 断言分三层：页面确实同时给出端口与密钥；页面里没有任何非 ASCII 之外需要转义的
 * 原始凭据；密钥**只**在回环上出现（非回环那一页不含它）。
 */
test('gatewayPageHtml：同时给出端口与密钥，且端口取自本次请求', () => {
  const settings = resolveConfig({ token: 'k'.repeat(40) }, () => 'unused');
  const html = gatewayPageHtml(settings, '127.0.0.1:52341');
  assert.match(html, /<code>52341<\/code>/, '端口必须出现在页面上');
  assert.match(html, /<code id="token">k{40}<\/code>/, '密钥必须出现在页面上');
  assert.match(html, /<code>dsharness_auth<\/code>/, 'cookie 名也要给出，否则调用方拼不出第二条路');
  assert.match(html, /Authorization: Bearer/, '页面必须写清怎么用这把密钥');
  // 换一个 authority 就换一个端口 —— 端口是本次请求的事实，不是另存的一份配置。
  assert.match(gatewayPageHtml(settings, 'localhost:8080'), /<code>8080<\/code>/);
  // 自动生成的密钥要在页面上说明来源，否则用户会以为是自己配的那把。
  assert.match(
    gatewayPageHtml(resolveConfig({}, () => 'g'.repeat(43)), '127.0.0.1:1'),
    /本次自动生成/,
  );
});

test('gatewayPageHtml：密钥被转义后再进 HTML', () => {
  // 密钥正常情况下是 base64url，但页面不该依赖「值一定是安全的」这件事。
  const html = gatewayPageHtml(resolveConfig({ token: 'a'.repeat(20) + '<script>' }, () => 'x'), '127.0.0.1:1');
  assert.ok(!html.includes('<code id="token">a'.repeat(1) + '<script>'), 'the raw value must not reach the document');
  assert.match(html, /&lt;script&gt;/);
  assert.equal(escapeHtml(`<&">'`), '&lt;&amp;&quot;&gt;&#39;');
});

test('offHostPageHtml：非回环那一页不含任何凭据', () => {
  const settings = resolveConfig({ token: 's'.repeat(40) }, () => 'x');
  const page = offHostPageHtml();
  assert.ok(!page.includes(settings.token), 'the off-host page must not carry the secret');
  assert.match(page, /回环/);
});

test('STATUS_PATHS：登录页与两个网关信息面都在放行名单里', () => {
  // `frontend-static` 把首页之外的一切交给 `authorizeIndex`，而它只认 `GET /`；
  // 不进这个名单的话，本插件自己的页面能否被读到就取决于路由注册顺序。
  assert.deepEqual(PUBLIC_PATHS, ['/dsharness/auth', STATUS_PATH, STATUS_JSON_PATH]);
  assert.equal(STATUS_PATH, '/dsharness/gateway');
  assert.equal(STATUS_JSON_PATH, '/dsharness/gateway.json');
});

test('sendJson：不缓存，且给出准确的 content-length', () => {
  const written = [];
  const res = {
    writeHead: (status, headers) => written.push({ status, headers }),
    end: (body) => written.push({ body }),
  };
  sendJson(res, 200, { token: '秘密' });
  assert.equal(written[0].status, 200);
  assert.equal(written[0].headers['cache-control'], 'no-store');
  assert.equal(written[0].headers['content-length'], String(Buffer.byteLength(written[1].body)));
  assert.deepEqual(JSON.parse(written[1].body), { token: '秘密' });
});
