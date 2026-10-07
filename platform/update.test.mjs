import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ORIGIN,
  INSTALL_RECORD,
  RELEASE_PATH,
  UPDATE_JSON_PATH,
  UPDATE_PATH,
  apply,
  checkForUpdate,
  compareVersions,
  escapeHtml,
  name,
  pickRelease,
  readInstallRecord,
  resolveConfig,
  splitVersion,
  updatePageHtml,
} from './update.mjs';
import { DEFAULT_PLATFORM_ORIGIN } from './build-deploy-payload.mjs';

/**
 * 「检查更新」这一面。
 *
 * 用户口径：『要有检查更新的功能，也做在platform模块中，尽量不要修改源码』。
 *
 * 官方的通道在未签名构建下是死的，且不是配置问题：
 * `electron-builder-config.mjs:249` 在 unsigned 时 `publish: null`，
 * electron-builder 于是不写 `app-update.yml`
 * （`app-builder-lib/out/publish/PublishManager.js:87-90`），而
 * `update-coordinator.ts:54` 的 `enabled()` 正要求那个文件存在、`:185` 直接抛错。
 * 所以这一面自己实现，且只做「告诉你」——下载与安装仍由用户手动完成。
 *
 * 这里钉的是三件最容易悄悄错的事：版本比较（含预发布段）、
 * `release: null` 是合法状态而不是失败、以及页面与 JSON 给出同一份事实。
 */

/** 一个内存响应对象。 */
function respond(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** 记录请求的 fetch 桩。 */
function recorder(reply) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

test('版本比较：数字段、预发布段、以及「预发布小于正式」', () => {
  assert.equal(compareVersions('0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('0.2.2', '0.2.1'), 1);
  assert.equal(compareVersions('0.2.1', '0.2.10'), -1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  // 本产品实际使用的形态：0.2.1-alpha.1.<日期>.<序号>
  assert.equal(compareVersions('0.2.1-alpha.1.20261007.2', '0.2.1-alpha.1.20261007.1'), 1);
  assert.equal(compareVersions('0.2.1-alpha.1.20261007.2', '0.2.1-alpha.1.20261006.1'), 1);
  assert.equal(compareVersions('0.2.1-alpha.1.20261006.1', '0.2.1-alpha.1.20261007.2'), -1);
  // semver 的预发布规则：带预发布段的**小于**不带的那一个。
  assert.equal(compareVersions('0.2.1-alpha', '0.2.1'), -1);
  assert.equal(compareVersions('0.2.1', '0.2.1-rc.1'), 1);
  assert.equal(compareVersions('0.2.1-alpha.2', '0.2.1-alpha.10'), -1);
  // 前导 v 与 build metadata 不该影响结论。
  assert.equal(compareVersions('v0.2.1', '0.2.1'), 0);
  assert.equal(compareVersions('0.2.1+abc', '0.2.1'), 0);
});

test('splitVersion：把本产品那串版本拆成可比较的段', () => {
  assert.deepEqual(splitVersion('0.2.1-alpha.1.20261007.2'),
    { release: ['0', '2', '1'], prerelease: ['alpha', '1', '20261007', '2'] });
  assert.deepEqual(splitVersion('1.2.3'), { release: ['1', '2', '3'], prerelease: [] });
});

test('readInstallRecord：缺文件、坏 JSON、空版本都只是「不知道」', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-update-'));
  try {
    assert.equal(readInstallRecord(home), undefined);
    writeFileSync(join(home, INSTALL_RECORD), 'not json\n');
    assert.equal(readInstallRecord(home), undefined);
    writeFileSync(join(home, INSTALL_RECORD), '{"version":""}\n');
    assert.equal(readInstallRecord(home), undefined);
    writeFileSync(join(home, INSTALL_RECORD), '{"version":"0.2.1-alpha.1.20261007.2","installDir":"C:/x"}\n');
    assert.deepEqual(readInstallRecord(home), { version: '0.2.1-alpha.1.20261007.2', installDir: 'C:/x' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('pickRelease：release 为 null 是「还没发布」，不是一份空发布', () => {
  assert.equal(pickRelease({ ok: true, release: null }), undefined);
  assert.equal(pickRelease({ ok: true }), undefined);
  assert.equal(pickRelease(null), undefined);
  assert.equal(pickRelease({ release: { version: '  ' } }), undefined);
  assert.deepEqual(pickRelease({ release: { version: '0.2.1', notes: 'x' } }), { version: '0.2.1', notes: 'x' });
});

test('checkForUpdate：有新版、已是最新、未发布三种结论', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-update-'));
  try {
    writeFileSync(join(home, INSTALL_RECORD), '{"version":"0.2.1-alpha.1.20261006.1"}\n');
    const newer = recorder(respond(200, { ok: true, release: { version: '0.2.1-alpha.1.20261007.2', winUrl: 'https://oss/x.exe', notes: 'n' } }));
    const result = await checkForUpdate({ origin: 'https://www.czmanong.com', home, fetch: newer.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.current, '0.2.1-alpha.1.20261006.1');
    assert.equal(result.latest, '0.2.1-alpha.1.20261007.2');
    assert.equal(result.updateAvailable, true);
    assert.equal(result.downloadUrl, 'https://oss/x.exe');
    assert.equal(newer.calls[0].url, `https://www.czmanong.com${RELEASE_PATH}`);
    // 生产 nginx 对 `User-Agent: node*` 一律 403，默认 fetch 正好是 node。
    assert.equal(newer.calls[0].init.headers['user-agent'], 'dsharness-client/0.1');
    assert.equal(newer.calls[0].init.redirect, 'error');

    const same = recorder(respond(200, { ok: true, release: { version: '0.2.1-alpha.1.20261006.1' } }));
    assert.equal((await checkForUpdate({ origin: DEFAULT_ORIGIN, home, fetch: same.fetch })).updateAvailable, false);

    // 出厂状态：还没有任何已发布版本。合法 ⇒ ok:true、updateAvailable:false。
    const none = recorder(respond(200, { ok: true, release: null }));
    const unpublished = await checkForUpdate({ origin: DEFAULT_ORIGIN, home, fetch: none.fetch });
    assert.equal(unpublished.ok, true);
    assert.equal(unpublished.latest, null);
    assert.equal(unpublished.updateAvailable, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('checkForUpdate：网络失败与坏响应都如实报告，且永不抛出', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsharness-update-'));
  try {
    writeFileSync(join(home, INSTALL_RECORD), '{"version":"1.0.0"}\n');
    const down = recorder(new Error('ECONNREFUSED'));
    const unreachable = await checkForUpdate({ home, fetch: down.fetch });
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.reason, 'unreachable');
    assert.equal(unreachable.current, '1.0.0');

    const error = recorder(respond(503, {}));
    assert.equal((await checkForUpdate({ home, fetch: error.fetch })).reason, 'unreachable');

    const broken = recorder({ status: 200, ok: true, json: async () => { throw new Error('bad json') } });
    assert.equal((await checkForUpdate({ home, fetch: broken.fetch })).reason, 'malformed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('checkForUpdate：本 home 没有安装记录时仍然给出最新版本与下载链接', async () => {
  // 开发机、以及任何没经过安装器创建 home 的场景：不能因此整面不可用。
  const home = mkdtempSync(join(tmpdir(), 'dsharness-update-'));
  try {
    const stub = recorder(respond(200, { ok: true, release: { version: '0.2.1', winUrl: 'https://oss/y.exe' } }));
    const result = await checkForUpdate({ home, fetch: stub.fetch });
    assert.equal(result.ok, true);
    assert.equal(result.current, null);
    assert.equal(result.latest, '0.2.1');
    assert.equal(result.updateAvailable, false, '不知道当前版本就不能断言「有新版本」');
    assert.equal(result.downloadUrl, 'https://oss/y.exe');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resolveConfig：默认 origin 与打包烧进去的那个必须一致', () => {
  const saved = process.env.DSH_PLATFORM_ORIGIN;
  delete process.env.DSH_PLATFORM_ORIGIN;
  try {
    const settings = resolveConfig({});
    assert.equal(settings.enabled, true);
    // 两处字面量必须相同，否则装好的机器会去问一个不存在的版本清单。
    assert.equal(settings.origin, DEFAULT_PLATFORM_ORIGIN);
    assert.equal(DEFAULT_ORIGIN, DEFAULT_PLATFORM_ORIGIN);
    assert.equal(settings.origin.endsWith('/'), false, 'origin 不该带尾斜杠，否则拼出来的 URL 有两条斜杠');
    assert.equal(resolveConfig({ enabled: false }).enabled, false);
    assert.equal(resolveConfig({ origin: 'https://example.test/' }).origin, 'https://example.test');
  } finally {
    if (saved === undefined) delete process.env.DSH_PLATFORM_ORIGIN;
    else process.env.DSH_PLATFORM_ORIGIN = saved;
  }
});

test('updatePageHtml：结论、链接与「不能自动安装」的说明都在同一页上', () => {
  const available = updatePageHtml({
    ok: true, current: '0.2.1-alpha.1.20261006.1', latest: '0.2.1-alpha.1.20261007.2',
    updateAvailable: true, downloadUrl: 'https://oss/x.exe', notes: '修了两个问题',
  });
  assert.match(available, /0\.2\.1-alpha\.1\.20261006\.1/);
  assert.match(available, /0\.2\.1-alpha\.1\.20261007\.2/);
  assert.match(available, /有新版本/);
  assert.match(available, /href="https:\/\/oss\/x\.exe"/);
  assert.match(available, /修了两个问题/);
  // 未签名 ⇒ 不能自己装，这一句必须在页面上，否则用户会以为点一下就会更新。
  assert.match(available, /不能自动安装/);

  assert.match(updatePageHtml({ ok: true, current: '1.0.0', latest: '1.0.0', updateAvailable: false }), /已是最新/);
  assert.match(updatePageHtml({ ok: true, current: '1.0.0', latest: null, updateAvailable: false }), /尚未发布/);
  assert.match(updatePageHtml({ ok: false, current: '1.0.0', reason: 'unreachable', message: 'boom' }), /暂时查不到/);
  // 没有安装记录 ⇒ 明确说明，而不是显示一个假的「已是最新」。
  assert.match(updatePageHtml({ ok: true, current: null, latest: '2.0.0', updateAvailable: false }), /没有安装记录/);
});

test('updatePageHtml：清单里的 URL 与说明都被转义', () => {
  const html = updatePageHtml({
    ok: true, current: '1.0.0', latest: '2.0.0', updateAvailable: true,
    downloadUrl: 'https://oss/x.exe?a=1&b="2"', notes: '<script>alert(1)</script>',
  });
  assert.ok(!html.includes('<script>alert(1)</script>'), 'the raw notes must not reach the document');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a=1&amp;b=&quot;2&quot;/);
  assert.equal(escapeHtml(`<&">'`), '&lt;&amp;&quot;&gt;&#39;');
});

test('apply：两个只读路由，注册为 exact，且 Get 之外的动作用 405', async () => {
  const routes = [];
  const logged = [];
  const ctx = {
    logger: { info: (m) => logged.push(m), warn: (m) => logged.push(m) },
    effect: (factory) => factory(),
    webServer: { register: (route) => { routes.push(route); return () => undefined } },
  };
  apply(ctx, { home: mkdtempSync(join(tmpdir(), 'dsharness-update-')) });
  assert.deepEqual(routes.map((route) => route.path).sort(), [UPDATE_JSON_PATH, UPDATE_PATH].sort());
  // exact 是关键：webServer.match() 先查 exact 表，精确路由不会落到 index 兜底上，
  // 因此不需要像 host-auth 那样在 authorizeIndex 上放行。
  for (const route of routes) assert.equal(route.kind, 'exact');

  const json = routes.find((route) => route.path === UPDATE_JSON_PATH);
  const written = { head: undefined, body: undefined };
  const res = { writeHead: (status, headers) => { written.head = { status, headers }; }, end: (body) => { written.body = body; } };
  await json.handler({ method: 'POST' }, res);
  assert.equal(written.head.status, 405);

  // enabled:false 时不注册任何路由。
  const off = [];
  apply({ ...ctx, webServer: { register: (route) => { off.push(route); return () => undefined } } }, { enabled: false });
  assert.deepEqual(off, []);
  assert.ok(logged.some((line) => line.includes('已关闭')));
});

test('apply：插件名、注入面与路径都是稳定契约', async () => {
  const module = await import('./update.mjs');
  assert.equal(name, 'dsharness-update');
  assert.deepEqual(module.inject, ['webServer']);
  assert.equal(UPDATE_PATH, '/dsharness/update');
  assert.equal(UPDATE_JSON_PATH, '/dsharness/update.json');
  assert.equal(INSTALL_RECORD, 'dsharness-install.json');
});
