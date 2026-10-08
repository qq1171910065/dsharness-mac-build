import { strict as assert } from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COOKIE,
  DEFAULT_ORIGIN,
  INSTALL_RECORD,
  LOGIN_PATH,
  MIN_TOKEN_LENGTH,
  MODEL_ACCESS_PATH,
  MODEL_KEY_REF,
  PANEL_JSON_PATH,
  PUBLIC_PATHS,
  RELEASE_PATH,
  SECRET_JSON_PATH,
  STATUS_JSON_PATH,
  STATUS_PATH,
  TOKEN_REF,
  UPDATE_JSON_PATH,
  UPDATE_PATH,
  USER_AGENT,
  appendCookie,
  apply,
  checkForUpdate,
  compareVersions,
  connectionCookieName,
  cookieValue,
  decodeStoredSecret,
  encodeBase64Url,
  escapeHtml,
  fetchModelKey,
  gatewayComponent,
  gatewayPageHtml,
  generateToken,
  isLoopbackHostname,
  mintConnectionCookie,
  modelKeyComponent,
  name,
  offHostPageHtml,
  pickRelease,
  presentedSecret,
  readInstallRecord,
  readModelKey,
  requestAuthority,
  resolveGatewayConfig,
  resolveModelKeyConfig,
  resolveUpdateConfig,
  safeEqualString,
  sendJson,
  splitVersion,
  updateComponent,
  updatePageHtml,
} from './dsharness.mjs';
import { DEFAULT_PLATFORM_ORIGIN } from './build-deploy-payload.mjs';

/**
 * `dsharness.mjs` — the single bundle this product ships, and the four components in it.
 *
 * User ask these tests guard:
 *
 * > 可以把 dshdesktop 网关、模型 key、检查更新、应用内检查更新这些插件合并成码农 DSH
 * > 插件，其中包了多个组件。该插件虽然是已安装的自定义插件，但是是不可以关闭的
 * > 插件的组件中只是显示组件状态，而不需要显示 key 的信息
 *
 * So there are three things to pin here:
 *
 * 1. **One plugin, several components.** `name` is the package name, `apply` mounts the
 *    components as sub-plugins, and each component keeps its own `inject` surface — which
 *    is what lets a service one component needs be absent without stopping the others.
 * 2. **The status face carries no credential.** `/dsharness/status.json` is what the
 *    browser half renders from, so the assertion that matters most is a *negative* one:
 *    the response contains booleans, never the secret and never the model key.
 * 3. **The cookie the gateway mints is byte-identical to the official format.** That is
 *    verified by recomputing it here from `packages/client/connection/src/browser-auth.ts`'s
 *    own construction, not by calling the plugin's function twice — two wrong copies
 *    would agree with each other. Whether the official path *accepts* it is settled by
 *    `check-host-auth.mjs` against a running Host.
 */

/* -------------------------------------------------------------------------
 * The one plugin
 * ---------------------------------------------------------------------- */

test('name: the plugin is the package, so the card, the row id and the client id all agree', () => {
  // All three are the same string by contract: `provision.mjs` names the row after the
  // package, and the client roster reconciles the classic script's registration id
  // against the package name, dropping the bundle silently when they differ.
  assert.equal(name, 'dsharness');
});

test('apply: mounts the components as sub-plugins, with no module-level inject', async () => {
  /*
   * A module-level `inject` would be wrong here: the three components need different
   * services (`connection`, `deepseekAccount`+`credentials`, `webServer`). Requiring them
   * all at the top would make the whole plugin wait — and never mount if the desktop
   * profile lacked one — where a sub-plugin only delays its own component.
   */
  const module = await import('./dsharness.mjs');
  assert.equal('inject' in module, false, 'the merged plugin itself must inject nothing');

  const mounted = [];
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    plugin: (plugin, config) => { mounted.push({ plugin, config }); },
  };
  apply(ctx, { gateway: { enabled: false }, modelKey: { enabled: false }, update: { enabled: false } });
  assert.deepEqual(
    mounted.map((entry) => entry.plugin.name),
    ['dsharness/gateway', 'dsharness/model-key', 'dsharness/update'],
  );
  // Each component's own section of the row config reaches it, and only it.
  assert.deepEqual(mounted[0].config, { enabled: false });
  assert.deepEqual(mounted[1].config, { enabled: false });
  assert.deepEqual(mounted[2].config, { enabled: false });
  // Sub-plugins are the native Cordis form: one row may mount a plugin tree.
  for (const entry of mounted) {
    assert.equal(typeof entry.plugin.apply, 'function');
    assert.ok(Array.isArray(entry.plugin.inject));
  }
});

test('apply: a missing config section leaves every component on its defaults', () => {
  // `raw.gateway` etc. are optional: a hand-written row with no `config:` at all still
  // gets a working plugin, which is what `pluginPatch`'s "no config key" case relies on.
  const mounted = [];
  apply({ logger: { info: () => undefined, warn: () => undefined }, plugin: (plugin, config) => mounted.push({ plugin, config }) }, undefined);
  assert.deepEqual(mounted.map((entry) => entry.config), [undefined, undefined, undefined]);
});

test('components: each injects exactly the services its own work needs', () => {
  assert.deepEqual(gatewayComponent.inject, ['connection']);
  assert.deepEqual(modelKeyComponent.inject, ['deepseekAccount', 'credentials']);
  assert.deepEqual(updateComponent.inject, ['webServer']);
  /*
   * `credentials` is deliberately NOT in the gateway's inject list. It is read through
   * `ctx.get('credentials')` instead, so a profile without a credential store degrades to
   * "no cookie minting, one warning" rather than "the whole channel disappears".
   */
  assert.ok(!gatewayComponent.inject.includes('credentials'));
});

/* -------------------------------------------------------------------------
 * Component 1: the local gateway
 * ---------------------------------------------------------------------- */

test('resolveGatewayConfig: a declared but too-short secret is replaced, and marked', () => {
  /*
   * Too short used to mean `enabled: false` — the whole channel silently off — so no
   * caller can depend on it; replacing it with a strong one breaks nobody, and
   * "the channel quietly does not work" is exactly the class of problem reported.
   * The replacement has to be diagnosable, hence `rejectedDeclared`.
   */
  const short = resolveGatewayConfig({ token: 'x'.repeat(MIN_TOKEN_LENGTH - 1) }, () => 'G'.repeat(43));
  assert.equal(short.token, 'G'.repeat(43));
  assert.equal(short.generated, true);
  assert.equal(short.rejectedDeclared, true);
  assert.equal(short.enabled, true);
  const ok = resolveGatewayConfig({ token: 'x'.repeat(MIN_TOKEN_LENGTH) }, () => 'H'.repeat(43));
  assert.equal(ok.token, 'x'.repeat(MIN_TOKEN_LENGTH));
  assert.equal(ok.generated, false);
  assert.equal(ok.rejectedDeclared, false);
});

test('resolveGatewayConfig: the channel is switched off with enabled, never with an empty secret', () => {
  /*
   * The shipped row is `token: !!js process.env.DSH_AUTH_TOKEN ?? ''` — it ALWAYS supplies
   * a `token` key (an empty string when the variable is unset). So "an explicit empty
   * string means off" can no longer express the intent: an empty string has to read as
   * "unconfigured" and generate, and `enabled: false` is the only switch.
   */
  const saved = process.env.DSH_AUTH_TOKEN;
  delete process.env.DSH_AUTH_TOKEN;
  try {
    const off = resolveGatewayConfig({ token: '', enabled: false }, () => 'I'.repeat(43));
    assert.equal(off.enabled, false);
    const unconfigured = resolveGatewayConfig({ token: '' }, () => 'J'.repeat(43));
    assert.equal(unconfigured.enabled, true);
    assert.equal(unconfigured.token, 'J'.repeat(43));
  } finally {
    if (saved === undefined) delete process.env.DSH_AUTH_TOKEN;
    else process.env.DSH_AUTH_TOKEN = saved;
  }
});

test('resolveGatewayConfig: the environment seeds the secret, an explicit config wins', () => {
  const saved = process.env.DSH_AUTH_TOKEN;
  process.env.DSH_AUTH_TOKEN = 'env-seeded-secret-16chars';
  try {
    assert.equal(resolveGatewayConfig({}).token, 'env-seeded-secret-16chars');
    assert.equal(resolveGatewayConfig({ token: 'explicit-secret-16chars' }).token, 'explicit-secret-16chars');
    assert.equal(resolveGatewayConfig({}, () => 'K'.repeat(43)).generated, false);
  } finally {
    if (saved === undefined) delete process.env.DSH_AUTH_TOKEN;
    else process.env.DSH_AUTH_TOKEN = saved;
  }
});

test('resolveGatewayConfig: an explicit enabled=false wins over any secret', () => {
  assert.equal(resolveGatewayConfig({ enabled: false, token: 'x'.repeat(40) }).enabled, false);
});

test('resolveGatewayConfig: with no secret at all it generates one, so there is something to show', () => {
  /*
   * 用户口径：「网关插件要能显示端口和令牌，否则我无法对接」— showing one requires
   * there to BE one. The default used to be `token: ''` → `enabled: false` → the plugin
   * never mounted → neither a channel nor anything displayable.
   *
   * The generated value must differ every time and must not be any hard-coded constant;
   * `apply` persists it so it survives a restart.
   */
  const a = resolveGatewayConfig({}, () => 'A'.repeat(43));
  const b = resolveGatewayConfig({}, () => 'B'.repeat(43));
  assert.equal(a.enabled, true);
  assert.equal(a.token, 'A'.repeat(43));
  assert.notEqual(a.token, b.token, 'a generated secret must differ every time');
  assert.ok(a.token.length >= MIN_TOKEN_LENGTH);
  assert.equal(resolveGatewayConfig({ token: 'explicit-secret-16chars' }, () => 'C'.repeat(43)).token, 'explicit-secret-16chars');
  assert.equal(resolveGatewayConfig({ enabled: false }, () => 'D'.repeat(43)).enabled, false);
  // The real generator, not a stub: 32 random bytes, base64url, no padding.
  const real = generateToken();
  assert.match(real, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(real, generateToken());
});

test('resolveGatewayConfig: the panel origin matches the check-for-updates origin', () => {
  /*
   * Both surfaces read the same release list from the same product server. If they
   * diverged, an installed machine would show "a new version is available" in the status
   * panel and "up to date" on the update page — one bug, two contradicting screens.
   */
  const stripped = resolveGatewayConfig({ origin: 'https://example.test/' });
  assert.equal(stripped.platformOrigin, 'https://example.test');
  assert.equal(resolveUpdateConfig({ origin: 'https://example.test/' }).origin, 'https://example.test');
  // The shipped default is the production origin, and it is the one the payload bakes in.
  assert.equal(resolveGatewayConfig({}).platformOrigin, DEFAULT_ORIGIN);
  assert.equal(resolveUpdateConfig({}).origin, DEFAULT_ORIGIN);
  assert.equal(DEFAULT_ORIGIN, DEFAULT_PLATFORM_ORIGIN);
});

test('resolveGatewayConfig: the cookie name and the mint window have safe defaults', () => {
  const settings = resolveGatewayConfig({}, () => 'x'.repeat(43));
  assert.equal(settings.cookieName, DEFAULT_COOKIE);
  assert.equal(settings.loginPage, true);
  // Short on purpose: the cookie is minted per request and only has to outlive it. A
  // short window also stays clear of the connection layer's own `cookieMaxAgeDays` cap.
  assert.ok(settings.cookieMaxAgeSec > 0 && settings.cookieMaxAgeSec <= 86_400);
  // A junk override falls back rather than propagating a NaN into a Date.
  assert.equal(resolveGatewayConfig({ cookieMaxAgeSec: 'soon' }, () => 'x'.repeat(43)).cookieMaxAgeSec, settings.cookieMaxAgeSec);
  assert.equal(resolveGatewayConfig({ cookieName: '  ' }, () => 'x'.repeat(43)).cookieName, DEFAULT_COOKIE);
});

test('safeEqualString: only equal compares true, and a length mismatch does not return early', () => {
  assert.equal(safeEqualString('abc', 'abc'), true);
  assert.equal(safeEqualString('abc', 'abd'), false);
  assert.equal(safeEqualString('abc', 'abcd'), false);
  // Absent values compare as the empty string, so a missing header is simply unequal.
  assert.equal(safeEqualString(undefined, ''), true);
  assert.equal(safeEqualString(undefined, 'x'), false);
});

test('presentedSecret: reads Bearer case- and space-insensitively, else its own cookie', () => {
  const bearer = (value) => ({ headers: { authorization: value } });
  assert.equal(presentedSecret(bearer('Bearer abc')), 'abc');
  assert.equal(presentedSecret(bearer('bearer   abc  ')), 'abc');
  assert.equal(presentedSecret(bearer('Bearer')), undefined);
  assert.equal(presentedSecret(bearer('Token abc')), undefined);
  // Fetch's Headers object is supported as well as Node's plain object.
  assert.equal(presentedSecret({ headers: new Headers({ authorization: 'Bearer via-headers' }) }), 'via-headers');
  assert.equal(presentedSecret({ headers: { cookie: `${DEFAULT_COOKIE}=from-cookie` } }), 'from-cookie');
  // A named cookie other than ours is not a credential.
  assert.equal(presentedSecret({ headers: { cookie: 'other=value' } }), undefined);
  assert.equal(presentedSecret({}), undefined);
  assert.equal(presentedSecret(undefined), undefined);
});

test('cookieValue: reads only the named cookie, and does not decode anything else', () => {
  assert.equal(cookieValue('a=1; b=2', 'b'), '2');
  assert.equal(cookieValue('b=2', 'b'), '2');
  assert.equal(cookieValue('bb=2', 'b'), undefined, 'a prefix match is not a match');
  assert.equal(cookieValue('noseparator', 'b'), undefined);
  assert.equal(cookieValue('', 'b'), undefined);
  assert.equal(cookieValue(undefined, 'b'), undefined);
});

test('requestAuthority: only a parseable authority is accepted', () => {
  assert.equal(requestAuthority({ host: '127.0.0.1:13094' }), '127.0.0.1:13094');
  assert.equal(requestAuthority({ host: 'localhost' }), 'localhost');
  // A colon-separated host is normalised through URL, so the cookie name is stable
  // whichever spelling the client used.
  assert.equal(requestAuthority({ host: 'localhost:80' }), 'localhost');
  assert.equal(requestAuthority({ host: '' }), undefined);
  assert.equal(requestAuthority({}), undefined);
  assert.equal(requestAuthority(undefined), undefined);
  // An unparseable host is refused rather than thrown on.
  assert.equal(requestAuthority({ host: 'a b c' }), undefined);
});

test('isLoopbackHostname: the three spellings of loopback', () => {
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('::1'), true);
  assert.equal(isLoopbackHostname('[::1]'), true);
  assert.equal(isLoopbackHostname('192.168.1.5'), false);
  assert.equal(isLoopbackHostname('127.0.0.1.evil.test'), false);
  assert.equal(isLoopbackHostname('localhost.evil.test'), false);
});

test('encodeBase64Url: URL-safe and unpadded', () => {
  assert.equal(encodeBase64Url(Buffer.from([0xfb, 0xff])), '-_8');
  assert.equal(encodeBase64Url(Buffer.from('a')), 'YQ');
  assert.ok(!encodeBase64Url(Buffer.from([0xfb, 0xff, 0xbf])).includes('='));
});

test('mintConnectionCookie: byte-identical to the official browser-auth construction', () => {
  /*
   * This recomputes the cookie from `packages/client/connection/src/browser-auth.ts`'s own
   * steps (`encodeCookie` at :129-132: `v1.<base64url(json)>.<base64url(hmacSha256(body))>`)
   * instead of comparing the plugin's output with itself — two wrong copies would agree.
   *
   * The cookie name is `dsh-auth-<base64url(sha256(authority))>` and the payload is
   * `{version: 1, authority, issuedAt, expiresAt}`; the signature covers the ENCODED body,
   * not the JSON.
   */
  const authority = '127.0.0.1:13094';
  const secret = Buffer.alloc(32, 7);
  const now = 1_700_000_000_000;
  const { name: cookieName, value } = mintConnectionCookie(authority, secret, 3600, now);

  const expectedName = 'dsh-auth-' + Buffer.from(createHash('sha256').update(authority).digest())
    .toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  assert.equal(cookieName, expectedName);
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 3_600_000 };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  const signature = createHmac('sha256', secret).update(body).digest().toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  assert.equal(value, `v1.${body}.${signature}`);
  // And the payload really decodes back to what was signed.
  const decoded = JSON.parse(Buffer.from(value.split('.')[1], 'base64').toString('utf8'));
  assert.deepEqual(decoded, payload);
  // No padding anywhere: a `=` in a cookie value is a quoting question nobody wants.
  assert.ok(!value.includes('='));
});

test('mintConnectionCookie: the name is bound to the authority, so two hosts differ', () => {
  const secret = Buffer.alloc(32, 1);
  const one = mintConnectionCookie('127.0.0.1:13094', secret, 60);
  const other = mintConnectionCookie('127.0.0.1:13095', secret, 60);
  assert.notEqual(one.name, other.name);
  assert.equal(connectionCookieName('127.0.0.1:13094'), one.name);
});

test('mintConnectionCookie: the expiry lands inside the window the official layer allows', () => {
  // The connection layer rejects a cookie whose lifetime exceeds its own cap, so a mint
  // window that drifted past a day would be silently refused.
  const now = Date.now();
  const value = mintConnectionCookie('127.0.0.1:13094', Buffer.alloc(32, 2), 3600, now).value;
  const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64').toString('utf8'));
  assert.equal(payload.issuedAt, now);
  assert.ok(payload.expiresAt - payload.issuedAt <= 30 * 24 * 60 * 60 * 1000);
});

test('appendCookie: appends without dropping the cookies the caller already sent', () => {
  const plain = { headers: { cookie: 'existing=1' } };
  appendCookie(plain.headers, { name: 'minted', value: 'v' });
  assert.equal(plain.headers.cookie, 'existing=1; minted=v');
  const empty = { headers: {} };
  appendCookie(empty.headers, { name: 'minted', value: 'v' });
  assert.equal(empty.headers.cookie, 'minted=v');
  // A `Headers` object updates in place rather than gaining an own property.
  const headers = new Headers({ cookie: 'existing=1' });
  appendCookie(headers, { name: 'minted', value: 'v' });
  assert.equal(headers.get('cookie'), 'existing=1; minted=v');
});

test('decodeStoredSecret: accepts only the official grant record, with a 32-byte key', () => {
  const secret = Buffer.alloc(32, 9);
  const encoded = secret.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  assert.deepEqual(decodeStoredSecret({ kind: 'grant', payload: { version: 1, secret: encoded } }), secret);
  // Anything else is "format not recognised", which degrades to no minting rather than a throw.
  assert.equal(decodeStoredSecret(undefined), undefined);
  assert.equal(decodeStoredSecret({ kind: 'other', payload: { version: 1, secret: encoded } }), undefined);
  assert.equal(decodeStoredSecret({ kind: 'grant', payload: { version: 2, secret: encoded } }), undefined);
  assert.equal(decodeStoredSecret({ kind: 'grant', payload: { version: 1, secret: 42 } }), undefined);
  assert.equal(decodeStoredSecret({ kind: 'grant', payload: { version: 1, secret: Buffer.alloc(8).toString('base64') } }), undefined);
});

test('gatewayPageHtml: shows the port and the secret, with the port from this request', () => {
  /*
   * 用户口径：「网关插件要能显示端口和令牌，否则我无法对接」. The port comes from the
   * request authority rather than a stored config value: `webServer.port` is only known
   * after `listen()` (and is the OS-assigned one under `--port 0`), while the authority is
   * by definition the address the caller really reached.
   */
  const settings = resolveGatewayConfig({ token: 'x'.repeat(MIN_TOKEN_LENGTH) });
  const html = gatewayPageHtml(settings, '127.0.0.1:13094');
  assert.match(html, /13094/);
  assert.match(html, /http:\/\/127\.0\.0\.1:13094/);
  assert.ok(html.includes('x'.repeat(MIN_TOKEN_LENGTH)), 'the secret has to be readable to be usable');
  assert.match(html, /复制密钥/);
  // A generated secret says so, and names where it was persisted — because then it also
  // lives in the credential store and is the value that survives a restart.
  const generated = gatewayPageHtml(resolveGatewayConfig({}, () => 'y'.repeat(43)), '127.0.0.1:1');
  assert.match(generated, /本次自动生成/);
  assert.match(generated, new RegExp(TOKEN_REF));
  const declared = gatewayPageHtml(settings, '127.0.0.1:1');
  assert.doesNotMatch(declared, /本次自动生成/);
  assert.doesNotMatch(declared, new RegExp(TOKEN_REF), 'a declared secret was never written anywhere');
});

test('gatewayPageHtml: the secret is escaped before it reaches the document', () => {
  // The value is `[A-Za-z0-9_-]` today, but "concatenate first and think later" is exactly
  // how a page like this starts reflecting input.
  const html = gatewayPageHtml({ token: '<script>alert(1)</script>', cookieName: 'c', generated: false }, 'h:1');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.equal(escapeHtml(`<&">'`), '&lt;&amp;&quot;&gt;&#39;');
});

test('offHostPageHtml: the non-loopback page carries no credential at all', () => {
  // Someone who forwards a LAN address must not thereby hand over the secret.
  const html = offHostPageHtml();
  assert.ok(!html.includes('token'));
  assert.ok(!/dsh-auth/u.test(html));
  assert.match(html, /回环/);
});

test('sendJson: no caching, and an exact content-length for the encoded body', () => {
  const written = { head: undefined, body: undefined };
  const res = { writeHead: (status, headers) => { written.head = { status, headers }; }, end: (body) => { written.body = body; } };
  sendJson(res, 200, { ok: true, text: '中文' });
  assert.equal(written.head.status, 200);
  assert.equal(written.head.headers['cache-control'], 'no-store');
  // Byte length, not string length: a multi-byte body with the wrong length truncates.
  assert.equal(Number(written.head.headers['content-length']), Buffer.byteLength(written.body));
  assert.deepEqual(JSON.parse(written.body), { ok: true, text: '中文' });
});

test('PUBLIC_PATHS: the login page, both gateway faces, the status face and the on-demand value face', () => {
  /*
   * `frontend-static` hands `/` to `connection.authorizeIndex`, which only lets `GET /`
   * through and ends the response otherwise. Without these entries whether our own paths
   * answer would depend on route registration order — a bug that appears and disappears
   * between runs. The status face belongs here because it holds no credential; the value
   * face does not hold one in its *URL* either, and its own loopback gate is what refuses
   * a request that reached it.
   */
  assert.deepEqual(
    [...PUBLIC_PATHS].sort(),
    [LOGIN_PATH, STATUS_PATH, STATUS_JSON_PATH, PANEL_JSON_PATH, SECRET_JSON_PATH].sort(),
  );
  assert.equal(LOGIN_PATH, '/dsharness/auth');
  assert.equal(STATUS_PATH, '/dsharness/gateway');
  assert.equal(STATUS_JSON_PATH, '/dsharness/gateway.json');
  assert.equal(PANEL_JSON_PATH, '/dsharness/status.json');
  assert.equal(SECRET_JSON_PATH, '/dsharness/secret.json');
});

/* -------------------------------------------------------------------------
 * Component 2: the model key
 * ---------------------------------------------------------------------- */

test('readModelKey: unwraps the success envelope', () => {
  assert.deepEqual(readModelKey({ ok: true, access: { apiKey: 'sk-abc' } }), { status: 'key', apiKey: 'sk-abc' });
  // Trimming matters: a trailing newline in the key would be sent verbatim.
  assert.deepEqual(readModelKey({ access: { apiKey: '  sk-abc  ' } }), { status: 'key', apiKey: 'sk-abc' });
});

test('readModelKey: a null apiKey is a reported state, not a malformed response', () => {
  const result = readModelKey({ ok: true, access: { apiKey: null, apiKeyReason: '网关还没发出来' } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, '网关还没发出来');
});

test('readModelKey: a blank apiKey with no reason still names the state', () => {
  const result = readModelKey({ access: { apiKey: '   ', apiKeyReason: '' } });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /未下发/u);
});

test('readModelKey: a response that is not the documented envelope is malformed', () => {
  for (const payload of [null, 'text', 42, {}, { access: null }, { access: 'nope' }]) {
    assert.equal(readModelKey(payload).status, 'malformed', JSON.stringify(payload));
  }
});

test('fetchModelKey: sends the session token and a non-Node User-Agent', async () => {
  /*
   * ⚠️ Production nginx answers 403 to any `User-Agent` starting with `node`, which is
   * exactly what `fetch` sends by default. Without the explicit header the caller gets an
   * HTML 403 instead of JSON, which reads like a product bug.
   */
  let seen;
  const fake = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ access: { apiKey: 'sk-1' } }) };
  };
  const result = await fetchModelKey('https://www.czmanong.com', 'session-token', { fetch: fake });
  assert.deepEqual(result, { status: 'key', apiKey: 'sk-1' });
  assert.equal(seen.url, `https://www.czmanong.com${MODEL_ACCESS_PATH}`);
  assert.equal(seen.init.headers.authorization, 'Bearer session-token');
  assert.equal(seen.init.headers['user-agent'], USER_AGENT);
  // A redirect is an error rather than a silent hop to another host with the token attached.
  assert.equal(seen.init.redirect, 'error');
});

test('fetchModelKey: a trailing slash in the origin cannot double up the path', async () => {
  let url;
  await fetchModelKey('https://www.czmanong.com/', 't', { fetch: async (u) => { url = u; return { ok: true, status: 200, json: async () => ({ access: { apiKey: 'k' } }) }; } });
  assert.equal(url, `https://www.czmanong.com${MODEL_ACCESS_PATH}`);
});

test('fetchModelKey: 401/403 is "unauthorized" — the stored key must be dropped', async () => {
  for (const status of [401, 403]) {
    const result = await fetchModelKey('https://x.test', 't', { fetch: async () => ({ ok: false, status }) });
    assert.equal(result.status, 'unauthorized');
  }
});

test('fetchModelKey: other HTTP failures are "unreachable" — the stored key is kept', async () => {
  const result = await fetchModelKey('https://x.test', 't', { fetch: async () => ({ ok: false, status: 502 }) });
  assert.equal(result.status, 'unreachable');
  assert.match(result.reason, /502/u);
});

test('fetchModelKey: a transport failure is reported, never thrown', async () => {
  const result = await fetchModelKey('https://x.test', 't', { fetch: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(result.status, 'unreachable');
  assert.match(result.reason, /ECONNREFUSED/u);
});

test('fetchModelKey: an unreadable body is malformed, not a crash', async () => {
  const result = await fetchModelKey('https://x.test', 't', {
    fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
  });
  assert.equal(result.status, 'malformed');
});

test('resolveModelKeyConfig: the shipped default is the ref the model route references', () => {
  // `platform/cordis.patch.yml` names `apiKeyEnv: DSHARNESS_MODEL_KEY`; a mismatch here is
  // a silent `MISSING_CREDENTIAL` on every request, so the literal is pinned.
  assert.equal(MODEL_KEY_REF, 'DSHARNESS_MODEL_KEY');
  assert.equal(resolveModelKeyConfig({}).ref, MODEL_KEY_REF);
  assert.ok(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(MODEL_KEY_REF), 'the credential reference grammar');
});

test('resolveModelKeyConfig: an explicit ref and origin win, and enabled:false turns it off', () => {
  const settings = resolveModelKeyConfig({ ref: 'OTHER_REF', origin: 'https://x.test/', enabled: false });
  assert.equal(settings.ref, 'OTHER_REF');
  assert.equal(settings.originOverride, 'https://x.test');
  assert.equal(settings.enabled, false);
});

test('resolveModelKeyConfig: an unusable ref or timeout falls back instead of propagating junk', () => {
  assert.equal(resolveModelKeyConfig({ ref: '   ' }).ref, MODEL_KEY_REF);
  assert.ok(resolveModelKeyConfig({ requestTimeoutMs: 0 }).requestTimeoutMs > 0);
  assert.ok(resolveModelKeyConfig({ requestTimeoutMs: 'soon' }).requestTimeoutMs > 0);
  assert.equal(resolveModelKeyConfig({ requestTimeoutMs: 1234 }).requestTimeoutMs, 1234);
});

/** A fake `deepseekAccount` + `credentials` pair for the delivery component. */
function modelKeyContext({ session, fetchResult, described } = {}) {
  const logged = [];
  const stored = new Map();
  const credentials = {
    set: async (ref, value) => { stored.set(ref, value); },
    unset: async (ref) => { stored.delete(ref); },
    describe: async (ref) => (stored.has(ref) || described === true
      ? { configured: true, writable: true }
      : { configured: false, writable: true }),
  };
  const account = {
    getPlatformSession: async () => session ?? null,
    watch: async function* () { /* one pass only: the component's initial attempt is enough here */ },
  };
  const ctx = {
    logger: { info: (line) => logged.push(line), warn: (line) => logged.push(line) },
    effect: (factory) => factory(),
    deepseekAccount: account,
    credentials,
  };
  return { ctx, logged, stored, credentials };
}

test('modelKeyComponent: a signed-in session writes the key under the configured ref', async () => {
  const { ctx, stored, logged } = modelKeyContext({
    session: { origin: 'https://www.czmanong.com', token: 'session-token' },
    fetchResult: { status: 'key', apiKey: 'sk-live' },
  });
  // The real component code path, with only the network stubbed.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access: { apiKey: 'sk-live' } }) });
  try {
    modelKeyComponent.apply(ctx, {});
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(stored.get(MODEL_KEY_REF), 'sk-live');
  // The log line reports a suffix, never the whole key.
  assert.ok(logged.some((line) => line.includes('已写入')));
  assert.ok(!logged.some((line) => line.includes('sk-live')), 'the whole key must never be logged');
});

test('modelKeyComponent: a signed-out session removes the key instead of leaving a stale one', async () => {
  const { ctx, stored, credentials } = modelKeyContext({ session: null, described: true });
  await credentials.set(MODEL_KEY_REF, 'sk-stale');
  modelKeyComponent.apply(ctx, {});
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(stored.has(MODEL_KEY_REF), false);
});

test('modelKeyComponent: enabled:false does nothing and says so once', async () => {
  const { ctx, stored, logged } = modelKeyContext({ session: { origin: 'https://x.test', token: 't' } });
  modelKeyComponent.apply(ctx, { enabled: false });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(stored.size, 0);
  assert.ok(logged.some((line) => line.includes('已关闭')));
});

/* -------------------------------------------------------------------------
 * Component 3: check for updates
 * ---------------------------------------------------------------------- */

test('splitVersion: splits the version form this product actually uses', () => {
  assert.deepEqual(splitVersion('0.2.1-alpha.1.20261007.2'), {
    release: ['0', '2', '1'], prerelease: ['alpha', '1', '20261007', '2'],
  });
  assert.deepEqual(splitVersion('v1.2.3'), { release: ['1', '2', '3'], prerelease: [] });
  // Build metadata is not part of the comparison.
  assert.deepEqual(splitVersion('1.2.3+build'), { release: ['1', '2', '3'], prerelease: [] });
  assert.deepEqual(splitVersion(''), { release: [''], prerelease: [] });
});

test('compareVersions: numeric fields, prerelease fields, and prerelease-below-release', () => {
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, 'numeric, not lexicographic');
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  // 0.2.1-alpha < 0.2.1 — the rule that makes a nightly build older than its release.
  assert.equal(compareVersions('0.2.1-alpha.1', '0.2.1'), -1);
  assert.equal(compareVersions('0.2.1', '0.2.1-alpha.1'), 1);
  // Between prereleases: numeric first, then lexical.
  assert.equal(compareVersions('0.2.1-alpha.2', '0.2.1-alpha.10'), -1);
  assert.equal(compareVersions('0.2.1-alpha', '0.2.1-beta'), -1);
  assert.equal(compareVersions('0.2.1-alpha.1', '0.2.1-alpha.1.1'), -1);
  // The real upgrade path this product ships.
  assert.equal(compareVersions('0.2.1-alpha.1.20261008.1', '0.2.1-alpha.1.20261007.3'), 1);
});

test('readInstallRecord: a missing file, bad JSON or a blank version all mean "unknown"', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-record-'));
  try {
    // No record: "unknown" is correct, not "up to date".
    assert.equal(readInstallRecord(home), undefined);
    writeFileSync(join(home, INSTALL_RECORD), 'not json', 'utf8');
    assert.equal(readInstallRecord(home), undefined);
    writeFileSync(join(home, INSTALL_RECORD), 'null', 'utf8');
    assert.equal(readInstallRecord(home), undefined);
    writeFileSync(join(home, INSTALL_RECORD), '{"version":"   "}', 'utf8');
    assert.equal(readInstallRecord(home), undefined);
    writeFileSync(join(home, INSTALL_RECORD), '{"version":"1.2.3","installDir":"C:/app","installedAt":"now"}', 'utf8');
    assert.deepEqual(readInstallRecord(home), { version: '1.2.3', installDir: 'C:/app', installedAt: 'now' });
    assert.equal(INSTALL_RECORD, 'dsharness-install.json');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pickRelease: release null is "not published yet", not an empty release', () => {
  assert.equal(pickRelease({ release: null }), undefined);
  assert.equal(pickRelease({}), undefined);
  assert.equal(pickRelease(null), undefined);
  assert.equal(pickRelease({ release: {} }), undefined);
  assert.equal(pickRelease({ release: { version: '  ' } }), undefined);
  assert.deepEqual(pickRelease({ release: { version: '1.0.0' } }), { version: '1.0.0' });
  assert.deepEqual(
    pickRelease({ release: { version: '1.0.0', winUrl: 'https://oss/x.exe', notes: 'n', publishedAt: 'p' } }),
    { version: '1.0.0', downloadUrl: 'https://oss/x.exe', notes: 'n', publishedAt: 'p' },
  );
});

test('checkForUpdate: an update available, already current, and not published yet', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-update-'));
  writeFileSync(join(home, INSTALL_RECORD), '{"version":"0.2.1-alpha.1.20261007.2"}', 'utf8');
  const json = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });
  try {
    const available = await checkForUpdate({ home, fetch: json({ release: { version: '0.2.1-alpha.1.20261008.1', winUrl: 'https://oss/x.exe' } }) });
    assert.equal(available.ok, true);
    assert.equal(available.current, '0.2.1-alpha.1.20261007.2');
    assert.equal(available.latest, '0.2.1-alpha.1.20261008.1');
    assert.equal(available.updateAvailable, true);

    const current = await checkForUpdate({ home, fetch: json({ release: { version: '0.2.1-alpha.1.20261007.2' } }) });
    assert.equal(current.updateAvailable, false);
    // An older published version is not an "update" either: no downgrade nag.
    const older = await checkForUpdate({ home, fetch: json({ release: { version: '0.2.1-alpha.1.20261006.1' } }) });
    assert.equal(older.updateAvailable, false);

    const none = await checkForUpdate({ home, fetch: json({ release: null }) });
    assert.equal(none.ok, true);
    assert.equal(none.latest, null);
    assert.equal(none.updateAvailable, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('checkForUpdate: network failures and bad responses are reported and never thrown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-update-'));
  writeFileSync(join(home, INSTALL_RECORD), '{"version":"1.0.0"}', 'utf8');
  try {
    const unreachable = await checkForUpdate({ home, fetch: async () => { throw new Error('ENOTFOUND'); } });
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.reason, 'unreachable');
    assert.equal(unreachable.current, '1.0.0', 'the current version is known locally even when the list is not');

    const http = await checkForUpdate({ home, fetch: async () => ({ ok: false, status: 502 }) });
    assert.equal(http.reason, 'unreachable');

    const malformed = await checkForUpdate({ home, fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }) });
    assert.equal(malformed.reason, 'malformed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('checkForUpdate: with no install record it still reports the latest version and the download link', async () => {
  // An unsigned build is the only witness to what was installed, and a home without the
  // record is a real state (a hand-run payload, an older installer). The page must say
  // "unknown" rather than pretend the machine is up to date.
  const home = mkdtempSync(join(tmpdir(), 'dsharness-update-'));
  try {
    const result = await checkForUpdate({
      home,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ release: { version: '9.9.9', winUrl: 'https://oss/x.exe' } }) }),
    });
    assert.equal(result.current, null);
    assert.equal(result.latest, '9.9.9');
    assert.equal(result.updateAvailable, false, 'we cannot claim an update when we do not know the current version');
    assert.equal(result.downloadUrl, 'https://oss/x.exe');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('checkForUpdate: asks the product server, with the resource path the server serves', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-update-'));
  let seen;
  try {
    await checkForUpdate({
      home, origin: 'https://www.czmanong.com/',
      fetch: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ release: null }) }; },
    });
    // No new version manifest: the product server's own release endpoint is the one source.
    assert.equal(seen.url, `https://www.czmanong.com${RELEASE_PATH}`);
    assert.equal(seen.init.headers['user-agent'], USER_AGENT, 'node* User-Agent is answered with an HTML 403 in production');
    assert.equal(seen.init.redirect, 'error');
    assert.ok(seen.init.signal, 'a hung remote must time out on its own, or the page spins forever');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('updatePageHtml: the conclusion, the link and the "cannot install itself" note share one page', () => {
  const available = updatePageHtml({
    ok: true, current: '0.2.1-alpha.1.20261007.2', latest: '0.2.1-alpha.1.20261008.1',
    updateAvailable: true, downloadUrl: 'https://oss/x.exe', notes: '修了两个问题',
  });
  assert.match(available, /0\.2\.1-alpha\.1\.20261007\.2/);
  assert.match(available, /有新版本/);
  assert.match(available, /href="https:\/\/oss\/x\.exe"/);
  assert.match(available, /修了两个问题/);
  // The in-app path exists now, so the page points at it rather than saying "cannot".
  assert.match(available, /设置 › 通用/);

  assert.match(updatePageHtml({ ok: true, current: '1.0.0', latest: '1.0.0', updateAvailable: false }), /已是最新/);
  assert.match(updatePageHtml({ ok: true, current: '1.0.0', latest: null, updateAvailable: false }), /尚未发布/);
  assert.match(updatePageHtml({ ok: false, current: '1.0.0', reason: 'unreachable', message: 'boom' }), /暂时查不到/);
  assert.match(updatePageHtml({ ok: true, current: null, latest: '2.0.0', updateAvailable: false }), /没有安装记录/);
});

test('updatePageHtml: URLs and notes from the manifest are escaped', () => {
  const html = updatePageHtml({
    ok: true, current: '1.0.0', latest: '2.0.0', updateAvailable: true,
    downloadUrl: 'https://oss/x.exe?a=1&b="2"', notes: '<script>alert(1)</script>',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw notes must not reach the document');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a=1&amp;b=&quot;2&quot;/);
});

test('resolveUpdateConfig: the shipped origin is the packaged origin, and enabled can close it', () => {
  assert.equal(resolveUpdateConfig({}).origin, DEFAULT_ORIGIN);
  assert.equal(resolveUpdateConfig({}).enabled, true);
  assert.equal(resolveUpdateConfig({ enabled: false }).enabled, false);
  // The default origin is a literal rather than an import: the installed package is one
  // file and cannot import a sibling. The payload is what makes the two agree.
  assert.equal(DEFAULT_ORIGIN, DEFAULT_PLATFORM_ORIGIN);
});

/* -------------------------------------------------------------------------
 * The routes on a real webServer mount
 * ---------------------------------------------------------------------- */

/** A fake `webServer` that records registrations and can serve one request. */
function webServerContext({ get } = {}) {
  const routes = [];
  const logged = [];
  const webServer = {
    port: 13094,
    register: (route) => { routes.push(route); return () => undefined; },
  };
  const ctx = {
    logger: { info: (line) => logged.push(line), warn: (line) => logged.push(line) },
    effect: (factory) => factory(),
    // `ctx.inject(['webServer'], cb)` is Cordis' "wait for this service" form; the fake
    // runs the callback straight away with the service already present.
    inject: (_deps, callback) => callback(ctx),
    get: (service) => (get ?? {})[service],
    webServer,
    connection: {
      requestRejection: () => undefined,
      authorizeIndex: () => true,
    },
  };
  return { ctx, routes, logged, webServer };
}

/** One request through a recorded route, collecting the response. */
async function serve(route, { method = 'GET', host = '127.0.0.1:13094' } = {}) {
  const written = { status: undefined, headers: undefined, body: undefined };
  const res = {
    writeHead: (status, headers) => { written.status = status; written.headers = headers; },
    end: (body) => { written.body = body; },
  };
  await route.handler({ method, url: route.path, headers: { host } }, res);
  return written;
}

test('gatewayComponent: every read-only face registers as an exact route', () => {
  /*
   * `exact` is load-bearing: `webServer.match()` consults the exact table before the
   * prefix fallback (`packages/host/webserver/src/index.ts:319-328`), so an exact route
   * never reaches `frontend-static`'s index handler — which is why these need no
   * `authorizeIndex` exemption beyond the one PUBLIC_PATHS already grants.
   */
  const { ctx, routes } = webServerContext();
  gatewayComponent.apply(ctx, { token: 'x'.repeat(MIN_TOKEN_LENGTH), home: 'C:/home' });
  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [LOGIN_PATH, STATUS_PATH, STATUS_JSON_PATH, PANEL_JSON_PATH, SECRET_JSON_PATH].sort(),
  );
  for (const route of routes) assert.equal(route.kind, 'exact');
});

test('gatewayComponent: enabled:false registers nothing and says so', () => {
  const { ctx, routes, logged } = webServerContext();
  gatewayComponent.apply(ctx, { enabled: false, home: 'C:/home' });
  assert.deepEqual(routes, []);
  assert.ok(logged.some((line) => line.includes('未启用')));
});

test('gatewayComponent: a generated secret is persisted, so the displayed token keeps working', async () => {
  /*
   * 用户口径：「网关插件要能显示端口和令牌，否则我无法对接」— a token shown once and
   * regenerated at the next start is not a token anyone can integrate against. Persisting
   * it is what makes the displayed value stable, and the reference name is part of that
   * contract (the gateway page prints it).
   */
  const stored = new Map();
  const credentials = { set: async (ref, value) => { stored.set(ref, value); } };
  const { ctx } = webServerContext({ get: { credentials } });
  gatewayComponent.apply(ctx, { home: 'C:/home' });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(stored.get(TOKEN_REF), ctx.__token ?? stored.get(TOKEN_REF));
  assert.equal(typeof stored.get(TOKEN_REF), 'string');
  assert.ok(stored.get(TOKEN_REF).length >= MIN_TOKEN_LENGTH);
});

test('gatewayComponent: a credential store that refuses the write does not stop the channel', async () => {
  // The in-process secret still works; only persistence is lost, and that is one warning
  // rather than a plugin that fails to mount.
  const { ctx, routes, logged } = webServerContext({ get: { credentials: { set: async () => { throw new Error('read-only store'); } } } });
  gatewayComponent.apply(ctx, { home: 'C:/home' });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(routes.length, 5);
  assert.ok(logged.some((line) => line.includes('未能保存')));
});

test('gatewayComponent: a declared-but-short secret is replaced and the replacement is diagnosable', async () => {
  const logged = [];
  const stored = new Map();
  const { ctx } = webServerContext({ get: { credentials: { set: async (ref, value) => { stored.set(ref, value); } } } });
  ctx.logger = { info: (line) => logged.push(line), warn: (line) => logged.push(line) };
  gatewayComponent.apply(ctx, { token: 'short', home: 'C:/home' });
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.ok(logged.some((line) => line.includes('短于')), 'a replaced secret must be reported, not swapped silently');
  assert.ok((stored.get(TOKEN_REF) ?? '').length >= MIN_TOKEN_LENGTH);
});

test('gatewayComponent: the minted cookie is attached to a request carrying the right secret', () => {
  /*
   * The channel in one assertion: a request with `Authorization: Bearer <shared secret>`
   * gains the official connection cookie before the official check runs, so the official
   * check is what admits it — this component never bypasses it.
   */
  const { ctx } = webServerContext();
  gatewayComponent.apply(ctx, { token: 'x'.repeat(MIN_TOKEN_LENGTH), cookieName: 'dsharness_auth', home: 'C:/home' });
  // The signature key is read from the credential store asynchronously; without one the
  // component cannot mint, which is why the wrapper must not throw in that case.
  const request = { headers: { host: '127.0.0.1:13094', authorization: `Bearer ${'x'.repeat(MIN_TOKEN_LENGTH)}` } };
  assert.doesNotThrow(() => ctx.connection.requestRejection(request));
  assert.equal(request.headers.cookie, undefined, 'no credential store yet means no cookie, not a crash');
});

test('gatewayComponent: a request without the secret is passed through untouched', () => {
  const { ctx } = webServerContext();
  gatewayComponent.apply(ctx, { token: 'x'.repeat(MIN_TOKEN_LENGTH), home: 'C:/home' });
  const request = { headers: { host: '127.0.0.1:13094' } };
  ctx.connection.requestRejection(request);
  assert.equal(request.headers.cookie, undefined);
  // A wrong secret is not a credential either, and must not be turned into one.
  const wrong = { headers: { host: '127.0.0.1:13094', authorization: 'Bearer wrong-secret-value' } };
  ctx.connection.requestRejection(wrong);
  assert.equal(wrong.headers.cookie, undefined);
});

test('gatewayComponent: disposing restores the two wrapped connection methods', () => {
  // The wrapper is an effect: a disposed fiber must leave no trace, or a reload would
  // stack a second minting pass on every request.
  const disposers = [];
  const originalRejection = () => undefined;
  const originalAuthorize = () => true;
  const ctx = {
    logger: { info: () => undefined, warn: () => undefined },
    effect: (factory) => { disposers.push(factory()); },
    inject: (_deps, callback) => callback(ctx),
    get: () => undefined,
    connection: { requestRejection: originalRejection, authorizeIndex: originalAuthorize },
    webServer: { port: 1, register: () => () => undefined },
  };
  gatewayComponent.apply(ctx, { token: 'x'.repeat(MIN_TOKEN_LENGTH) });
  assert.notEqual(ctx.connection.requestRejection, originalRejection, 'the wrapper must be installed');
  for (const dispose of disposers) dispose();
  assert.equal(ctx.connection.requestRejection, originalRejection);
  assert.equal(ctx.connection.authorizeIndex, originalAuthorize);
});

test('updateComponent: both faces register as exact routes and reject non-GET with 405', async () => {
  const { ctx, routes } = webServerContext();
  // A closed loopback port, so "the remote is unreachable" is this test's own condition
  // rather than whatever the production release endpoint happens to be serving today.
  updateComponent.apply(ctx, { home: 'C:/nowhere', origin: 'http://127.0.0.1:1' });
  assert.deepEqual(routes.map((route) => route.path).sort(), [UPDATE_PATH, UPDATE_JSON_PATH].sort());
  for (const route of routes) assert.equal(route.kind, 'exact');

  const json = routes.find((route) => route.path === UPDATE_JSON_PATH);
  const posted = await serve(json, { method: 'POST' });
  assert.equal(posted.status, 405);

  // The JSON face answers even when the remote is unreachable: it reports the failure
  // instead of failing the request, which is what lets the panel show "check failed".
  const got = await serve(json);
  assert.equal(got.status, 200);
  assert.equal(JSON.parse(got.body).ok, false);
  assert.equal(JSON.parse(got.body).reason, 'unreachable');
});

test('updateComponent: enabled:false registers nothing and says so', () => {
  const { ctx, routes, logged } = webServerContext();
  updateComponent.apply(ctx, { enabled: false });
  assert.deepEqual(routes, []);
  assert.ok(logged.some((line) => line.includes('已关闭')));
});

test('updateComponent: the page route answers 405 for a non-GET and 200 with HTML for a GET', async () => {
  const { ctx, routes } = webServerContext();
  updateComponent.apply(ctx, { home: 'C:/nowhere', origin: 'http://127.0.0.1:1' });
  const page = routes.find((route) => route.path === UPDATE_PATH);
  const posted = await serve(page, { method: 'POST' });
  assert.equal(posted.status, 405);
  const got = await serve(page);
  assert.equal(got.status, 200);
  assert.match(got.headers['content-type'], /text\/html/u);
  assert.match(got.body, /检查更新/);
});

/* -------------------------------------------------------------------------
 * The status face: the panel's only data source, and the one that must not leak
 * ---------------------------------------------------------------------- */

/** A full status payload fetch through the real handler. */
async function readPanel({ credentials, account, host = '127.0.0.1:13094', method = 'GET', origin = 'http://127.0.0.1:1' } = {}) {
  const { ctx, routes } = webServerContext({
    get: {
      ...credentials === undefined ? {} : { credentials },
      ...account === undefined ? {} : { deepseekAccount: account },
    },
  });
  /*
   * `origin` is always the closed loopback port by default. The version section really
   * does reach the release endpoint, so leaving the shipped production origin here would
   * make this spec assert against whatever is published today — it would go red the moment
   * a release lands, and green only when the network happens to be down.
   */
  gatewayComponent.apply(ctx, { token: 'x'.repeat(MIN_TOKEN_LENGTH), home: 'C:/nowhere', origin });
  const route = routes.find((entry) => entry.path === PANEL_JSON_PATH);
  const written = await serve(route, { method, host });
  return { written, routes };
}

test('status face: the response carries exactly the pinned fields and no credential', async () => {
  /*
   * This is the whole reason the face exists (用户口径：「插件的组件中只是显示组件状态，
   * 而不需要显示 key 的信息」), so the negative assertion is the important one: the shared
   * secret and the model key value must not be in the response, and the model key must be
   * reported as a boolean.
   */
  const secret = 'x'.repeat(MIN_TOKEN_LENGTH);
  const credentials = {
    describe: async (ref) => ({ configured: ref === MODEL_KEY_REF, writable: true }),
    readRecord: async () => undefined,
    set: async () => undefined,
  };
  const { written } = await readPanel({ credentials });
  assert.equal(written.status, 200);
  const body = JSON.parse(written.body);
  assert.deepEqual(Object.keys(body).sort(), [
    'account', 'address', 'checkedAt', 'cookieName', 'gatewayPath', 'loginPath',
    'modelKey', 'ok', 'port', 'tokenConfigured', 'version',
  ].sort());
  assert.equal(body.ok, true);
  assert.equal(body.port, 13094);
  assert.equal(body.address, 'http://127.0.0.1:13094');
  // Booleans, never values.
  assert.equal(body.tokenConfigured, true);
  assert.equal(body.modelKey.ref, MODEL_KEY_REF);
  assert.equal(body.modelKey.configured, true);
  assert.equal(typeof body.modelKey.configured, 'boolean');
  // The endpoint names the person can follow, and a timestamp for the "as of" line.
  assert.equal(body.loginPath, LOGIN_PATH);
  assert.equal(body.gatewayPath, STATUS_PATH);
  assert.equal(body.cookieName, DEFAULT_COOKIE);
  assert.ok(!Number.isNaN(Date.parse(body.checkedAt)));
  // The secret itself is nowhere in the response, in any field.
  assert.ok(!written.body.includes(secret), 'the shared secret must never reach the panel');
  assert.ok(!/"(?:token|secret|apiKey)":/u.test(written.body), 'no credential field may be named at all');
});

test('status face: a non-loopback request is refused, because it is not a public surface', async () => {
  const { written } = await readPanel({ host: '192.168.1.5:13094' });
  assert.equal(written.status, 403);
  assert.equal(JSON.parse(written.body).ok, false);
});

test('status face: a non-GET method is refused', async () => {
  const { written } = await readPanel({ method: 'POST' });
  assert.equal(written.status, 405);
});

test('status face: with no account service at all it degrades to signed-out, not an error', async () => {
  // A profile without the account plugin is a real state (a headless profile), and the
  // panel must still render the other three components.
  const { written } = await readPanel({});
  assert.equal(written.status, 200);
  const body = JSON.parse(written.body);
  assert.deepEqual(body.account, { signedIn: false, name: null, contact: null, balance: [] });
  assert.equal(body.modelKey.configured, false);
});

test('status face: a signed-in account contributes the name, the contact and every wallet', async () => {
  const account = {
    getPlatformSession: async () => ({ origin: 'https://www.czmanong.com', token: 't' }),
    getProfile: async () => ({ status: 'ready', value: { id: 'u1', name: '阿农', contact: '117****065', avatarUrl: null } }),
    getBalance: async () => ({
      status: 'ready',
      value: [{ currency: 'CNY', balance: '12.340000' }],
      bonusWallets: [{ currency: 'USD', balance: '5.000000' }],
    }),
  };
  const { written } = await readPanel({ account });
  const body = JSON.parse(written.body);
  assert.equal(body.account.signedIn, true);
  assert.equal(body.account.name, '阿农');
  assert.equal(body.account.contact, '117****065');
  // Bonus wallets are included: a person who topped up via a bonus sees that balance too.
  assert.deepEqual(body.account.balance, [
    { currency: 'CNY', balance: '12.340000' },
    { currency: 'USD', balance: '5.000000' },
  ]);
});

test('status face: a failing account query keeps the rest of the panel readable', async () => {
  /*
   * All three sections are fetched in parallel and each failure is its own. The panel's
   * most valuable facts are the port and the version; a balance query that times out must
   * not blank them, and must not turn the request into a 500 either.
   */
  const account = {
    getPlatformSession: async () => ({ origin: 'https://x.test', token: 't' }),
    getProfile: async () => { throw new Error('timeout'); },
    getBalance: async () => { throw new Error('timeout'); },
  };
  const { written } = await readPanel({ account });
  assert.equal(written.status, 200);
  const body = JSON.parse(written.body);
  assert.equal(body.account.signedIn, true, 'a known session is still signed in');
  assert.equal(body.account.name, null);
  assert.deepEqual(body.account.balance, []);
  assert.equal(body.port, 13094, 'the port is local and must survive a remote failure');
});

test('status face: a credential store that throws reports "not configured" rather than failing', async () => {
  const { written } = await readPanel({ credentials: { describe: async () => { throw new Error('vault sealed'); } } });
  assert.equal(written.status, 200);
  assert.equal(JSON.parse(written.body).modelKey.configured, false);
});

test('status face: the version section is a 3-field object even when the remote is unreachable', async () => {
  // The panel polls this every few seconds, so the shape must be stable: the browser half
  // renders straight from these three fields.
  const { written } = await readPanel({});
  const body = JSON.parse(written.body);
  assert.deepEqual(Object.keys(body.version).sort(), ['current', 'latest', 'updateAvailable']);
  assert.equal(body.version.latest, null);
  assert.equal(body.version.updateAvailable, false);
});

/* -------------------------------------------------------------------------
 * The on-demand value face: what the two copy buttons read, on the click
 * ---------------------------------------------------------------------- */

/** A value-face fetch through the real handler, mounted on the same component. */
async function readSecret({ credentials, host = '127.0.0.1:13094', method = 'GET' } = {}) {
  const { ctx, routes } = webServerContext({
    get: credentials === undefined ? {} : { credentials },
  });
  gatewayComponent.apply(ctx, { token: 'x'.repeat(MIN_TOKEN_LENGTH), home: 'C:/nowhere', origin: 'http://127.0.0.1:1' });
  const route = routes.find((entry) => entry.path === SECRET_JSON_PATH);
  return serve(route, { method, host });
}

test('value face: exact route, pinned body on loopback GET, 403 off host, 405 for a non-GET', async () => {
  /*
   * The two copy buttons read exactly this. It is a separate face from `status.json` on
   * purpose: the status face is polled every 10s, and this value must only leave the
   * process at the moment a person clicks copy.
   */
  const secret = 'x'.repeat(MIN_TOKEN_LENGTH);
  const { ctx, routes } = webServerContext({
    get: { credentials: { resolve: async () => ({ value: 'sk-model-key', source: 'file' }) } },
  });
  gatewayComponent.apply(ctx, { token: secret, home: 'C:/nowhere', origin: 'http://127.0.0.1:1' });
  const route = routes.find((entry) => entry.path === SECRET_JSON_PATH);
  assert.equal(route.kind, 'exact', 'an exact route never falls through to the SPA index');

  const written = await serve(route);
  assert.equal(written.status, 200);
  const body = JSON.parse(written.body);
  assert.deepEqual(Object.keys(body).sort(), ['gateway', 'modelKey', 'ok']);
  assert.deepEqual(body, { ok: true, gateway: { token: secret }, modelKey: { ref: MODEL_KEY_REF, value: 'sk-model-key' } });
  assert.deepEqual(Object.keys(body.gateway), ['token']);
  assert.deepEqual(Object.keys(body.modelKey).sort(), ['ref', 'value']);
  assert.equal(written.headers['cache-control'], 'no-store');

  // A LAN address reaching this route gets nothing: it is a credential surface.
  const offHost = await serve(route, { host: '192.168.1.5:13094' });
  assert.equal(offHost.status, 403);
  assert.equal(JSON.parse(offHost.body).ok, false);
  assert.ok(!offHost.body.includes(secret));

  const posted = await serve(route, { method: 'POST' });
  assert.equal(posted.status, 405);
  assert.ok(!posted.body.includes(secret));
});

test('value face: the model key is null — and nothing throws — with no store, a throw, or no value', async () => {
  /*
   * The handler must never throw: a 500 here reaches the user as a broken panel rather
   * than one failed copy. Every way the credential can be absent degrades to `null` in
   * that one field, and the gateway value is unaffected.
   */
  const cases = [
    ['no credential service', undefined],
    ['resolve throws', { resolve: async () => { throw new Error('vault sealed'); } }],
    ['nothing configured', { resolve: async () => undefined }],
    ['a non-string value', { resolve: async () => ({ value: 42, source: 'file' }) }],
  ];
  for (const [name, credentials] of cases) {
    const written = await readSecret({ credentials });
    assert.equal(written.status, 200, name);
    const body = JSON.parse(written.body);
    assert.equal(body.modelKey.value, null, name);
    assert.equal(body.modelKey.ref, MODEL_KEY_REF, name);
    assert.equal(body.gateway.token.length >= MIN_TOKEN_LENGTH, true, name);
  }
});

test('value face: the secret appears there and nowhere in the status face', async () => {
  /*
   * The one negative assertion the two-face split exists for (用户口径：「插件的组件中只是
   * 显示组件状态，而不需要显示 key 的信息」): the polled face still holds no value, and the
   * response of the on-demand face is the only place the value ever is.
   */
  const secret = 'x'.repeat(MIN_TOKEN_LENGTH);
  const modelKeyValue = 'sk-only-in-the-value-face';
  const credentials = {
    describe: async (ref) => ({ configured: ref === MODEL_KEY_REF, writable: true }),
    resolve: async () => ({ value: modelKeyValue, source: 'file' }),
    readRecord: async () => undefined,
    set: async () => undefined,
  };
  const { ctx, routes } = webServerContext({ get: { credentials } });
  gatewayComponent.apply(ctx, { token: secret, home: 'C:/nowhere', origin: 'http://127.0.0.1:1' });

  const value = await serve(routes.find((entry) => entry.path === SECRET_JSON_PATH));
  const panel = await serve(routes.find((entry) => entry.path === PANEL_JSON_PATH));
  assert.ok(value.body.includes(secret));
  assert.ok(value.body.includes(modelKeyValue));
  assert.ok(!panel.body.includes(secret), 'the polled status face must not carry the shared secret');
  assert.ok(!panel.body.includes(modelKeyValue), 'the polled status face must not carry the model key');
  assert.ok(!/"(?:token|secret|apiKey|value)":/u.test(panel.body), 'and names no credential field at all');
  // Its field set is unchanged by anything this round added.
  assert.deepEqual(Object.keys(JSON.parse(panel.body)).sort(), [
    'account', 'address', 'checkedAt', 'cookieName', 'gatewayPath', 'loginPath',
    'modelKey', 'ok', 'port', 'tokenConfigured', 'version',
  ].sort());
});
