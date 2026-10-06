import { strict as assert } from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  MIN_TOKEN_LENGTH,
  appendCookie,
  cookieValue,
  decodeStoredSecret,
  encodeBase64Url,
  connectionCookieName,
  isLoopbackHostname,
  mintConnectionCookie,
  name,
  presentedSecret,
  requestAuthority,
  resolveConfig,
  safeEqualString,
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

test('resolveConfig：密钥短于下限就视为未启用', () => {
  assert.equal(resolveConfig({ token: 'x'.repeat(MIN_TOKEN_LENGTH - 1) }).enabled, false);
  assert.equal(resolveConfig({ token: 'x'.repeat(MIN_TOKEN_LENGTH) }).enabled, true);
});

test('resolveConfig：没有密钥就没有通道（不是「默认密钥」）', () => {
  const saved = process.env.DSH_AUTH_TOKEN;
  delete process.env.DSH_AUTH_TOKEN;
  try {
    assert.equal(resolveConfig({}).enabled, false);
    assert.equal(resolveConfig({}).token, '');
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
    /*
     * 「键存在但为空」= 显式关掉这个通道，不该被环境变量顶回来 ——
     * 否则「在本机关掉它」在配了环境变量的机器上做不到。
     */
    const empty = resolveConfig({ token: '' });
    assert.equal(empty.token, '');
    assert.equal(empty.enabled, false);
  } finally {
    if (saved === undefined) delete process.env.DSH_AUTH_TOKEN;
    else process.env.DSH_AUTH_TOKEN = saved;
  }
});

test('resolveConfig：显式 enabled=false 时密钥再长也不启用', () => {
  assert.equal(resolveConfig({ enabled: false, token: 'x'.repeat(40) }).enabled, false);
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
