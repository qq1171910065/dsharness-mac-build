import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  DEFAULT_REF,
  MODEL_ACCESS_PATH,
  USER_AGENT,
  apply,
  fetchModelKey,
  name,
  readModelKey,
  resolveConfig,
} from './model-key.mjs';

/**
 * The model-key delivery plugin.
 *
 * The user ask it answers:
 *
 * > 登录之后获取的key有问题
 *
 * Measured before this plugin existed: the product server returns the key at
 * `GET /api/account/model-access`, but nothing in `client/` ever read it — a grep
 * for `model-access` / `apiKeyCreated` / `dshModelKey` across `client/` was zero
 * hits. So the model route this product ships (`dsharness-relay`, whose
 * `apiKeyEnv` is {@link DEFAULT_REF}) had no credential at all and every request
 * failed with `MISSING_CREDENTIAL`.
 *
 * The assertions below are about the two things that are easy to get wrong and
 * invisible until a user complains: (1) which HTTP conditions mean "the key is
 * gone, delete the stored one" versus "the network hiccuped, keep it", and
 * (2) the request must not look like Node's default `fetch` to the production
 * gateway.
 */

/** A response stub: only the members the plugin touches. */
function respond(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    json: async () => body,
  };
}

/** A `fetch` that records its calls and answers with one canned response. */
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

test('readModelKey: unwraps the success envelope', () => {
  const result = readModelKey({ ok: true, access: { apiKey: 'sk-abc123' } });
  assert.deepEqual(result, { status: 'key', apiKey: 'sk-abc123' });
});

test('readModelKey: a null apiKey is a reported state, not a malformed response', () => {
  // 「没有 key」 is legitimate: the gateway may not have issued one yet. Reporting
  // it as malformed would make the plugin retry forever on a state it cannot fix.
  const result = readModelKey({ ok: true, access: { apiKey: null, apiKeyReason: '网关未返回令牌' } });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /网关未返回令牌/);
});

test('readModelKey: a blank apiKey with no reason still names the state', () => {
  const result = readModelKey({ ok: true, access: { apiKey: '   ' } });
  assert.equal(result.status, 'unavailable');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

test('readModelKey: a response that is not the documented envelope is malformed', () => {
  for (const payload of [null, 'nope', 42, {}, { ok: true }, { access: null }, { access: 'x' }]) {
    assert.equal(readModelKey(payload).status, 'malformed', JSON.stringify(payload));
  }
});

test('fetchModelKey: sends the session token and a non-Node User-Agent', async () => {
  const stub = recorder(respond(200, { ok: true, access: { apiKey: 'sk-live' } }));
  const result = await fetchModelKey('https://www.czmanong.com', 'session-jwt', { fetch: stub.fetch });
  assert.deepEqual(result, { status: 'key', apiKey: 'sk-live' });
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].url, `https://www.czmanong.com${MODEL_ACCESS_PATH}`);
  assert.equal(stub.calls[0].init.headers.authorization, 'Bearer session-jwt');
  /*
   * The production gateway sits behind nginx with an anti-abuse rule that 403s any
   * User-Agent starting with `node` — and Node's `fetch` default is exactly that.
   * The failure mode is an HTML 403 rather than JSON, which reads as "the product
   * server is broken" if nobody knows the rule.
   */
  assert.equal(stub.calls[0].init.headers['user-agent'], USER_AGENT);
  assert.ok(!USER_AGENT.startsWith('node'), 'the default Node user agent is blocked by the gateway');
  // A redirect out of the origin must never silently carry the session token.
  assert.equal(stub.calls[0].init.redirect, 'error');
});

test('fetchModelKey: a trailing slash in the origin cannot double up the path', async () => {
  const stub = recorder(respond(200, { ok: true, access: { apiKey: 'sk-x' } }));
  await fetchModelKey('https://www.czmanong.com/', 't', { fetch: stub.fetch });
  assert.equal(stub.calls[0].url, `https://www.czmanong.com${MODEL_ACCESS_PATH}`);
});

test('fetchModelKey: 401/403 is "unauthorized" — the stored key must be dropped', async () => {
  for (const status of [401, 403]) {
    const stub = recorder(respond(status, {}));
    const result = await fetchModelKey('https://www.czmanong.com', 't', { fetch: stub.fetch });
    assert.equal(result.status, 'unauthorized', String(status));
  }
});

test('fetchModelKey: other HTTP failures are "unreachable" — the stored key is kept', async () => {
  // A 500 from the product server says nothing about whether the gateway key is
  // still valid, so deleting it there would break a working client.
  for (const status of [500, 502, 503]) {
    const stub = recorder(respond(status, {}));
    const result = await fetchModelKey('https://www.czmanong.com', 't', { fetch: stub.fetch });
    assert.equal(result.status, 'unreachable', String(status));
  }
});

test('fetchModelKey: a transport failure is reported, never thrown', async () => {
  const stub = recorder(new Error('ECONNREFUSED'));
  const result = await fetchModelKey('https://www.czmanong.com', 't', { fetch: stub.fetch });
  assert.equal(result.status, 'unreachable');
  assert.match(result.reason, /ECONNREFUSED/);
});

test('fetchModelKey: an unreadable body is malformed, not a crash', async () => {
  const stub = recorder({
    status: 200,
    ok: true,
    json: async () => { throw new Error('unexpected end of JSON') },
  });
  const result = await fetchModelKey('https://www.czmanong.com', 't', { fetch: stub.fetch });
  assert.equal(result.status, 'malformed');
});

test('resolveConfig: the shipped default is the ref the model route references', () => {
  const settings = resolveConfig();
  assert.equal(settings.enabled, true);
  assert.equal(settings.ref, DEFAULT_REF);
  assert.equal(settings.originOverride, undefined);
  assert.ok(settings.requestTimeoutMs > 0);
});

test('resolveConfig: an explicit ref and origin win, and enabled:false turns it off', () => {
  const settings = resolveConfig({ ref: 'OTHER_KEY', origin: 'https://example.test/', enabled: false, requestTimeoutMs: 1234 });
  assert.equal(settings.ref, 'OTHER_KEY');
  assert.equal(settings.originOverride, 'https://example.test', 'the trailing slash is normalized away');
  assert.equal(settings.enabled, false);
  assert.equal(settings.requestTimeoutMs, 1234);
});

test('resolveConfig: an unusable ref or timeout falls back instead of propagating junk', () => {
  const settings = resolveConfig({ ref: '   ', requestTimeoutMs: 0 });
  assert.equal(settings.ref, DEFAULT_REF);
  assert.ok(settings.requestTimeoutMs > 0);
});

/**
 * A minimal Cordis-shaped context.
 *
 * Only the members `apply` actually uses are implemented, so the test fails loudly
 * if the plugin starts reaching for something else.
 */
function makeContext({ session, describe = async () => ({ configured: false, writable: true }) }) {
  const logged = [];
  const writes = [];
  const unsets = [];
  const effects = [];
  let release;
  const done = new Promise((resolve) => { release = resolve });
  const ctx = {
    logger: {
      info: (message) => logged.push(['info', message]),
      warn: (message) => logged.push(['warn', message]),
    },
    credentials: {
      set: async (ref, value) => { writes.push([ref, value]) },
      unset: async (ref) => { unsets.push(ref) },
      describe: async (ref) => describe(ref),
    },
    deepseekAccount: {
      getPlatformSession: async () => session(),
      // Never yields: the plugin's subscription is left pending so the test can
      // observe the first sync without racing the watcher.
      watch: async function* (signal) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        release();
      },
    },
    effect: (factory) => {
      const dispose = factory();
      effects.push(dispose);
      return dispose;
    },
    release,
    done,
  };
  return { ctx, logged, writes, unsets, effects, done };
}

/** Let the plugin's first async turn settle. */
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)) };

test('apply: a signed-in session writes the key under the configured ref', async () => {
  const { ctx, writes, logged } = makeContext({
    session: () => ({ origin: 'https://www.czmanong.com', token: 'session-jwt', userId: '12' }),
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, `https://www.czmanong.com${MODEL_ACCESS_PATH}`);
      assert.equal(init.headers.authorization, 'Bearer session-jwt');
      return respond(200, { ok: true, access: { apiKey: 'sk-delivered' } });
    };
    apply(ctx, undefined);
    await settle();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(writes, [[DEFAULT_REF, 'sk-delivered']]);
  // The log must not contain the whole secret.
  const joined = logged.map(([, message]) => message).join('\n');
  assert.ok(!joined.includes('sk-delivered'), 'the log must not echo the key');
  assert.ok(joined.includes('sk-delivered'.slice(-4)), 'a four-character suffix is the most the log may show');
});

test('apply: a signed-out session removes the key instead of leaving a stale one', async () => {
  // configured:true models a key left by a previous run, which is the case that
  // actually needs the delete — the common path is a no-op by design.
  const { ctx, writes, unsets } = makeContext({
    session: () => null,
    describe: async () => ({ configured: true, writable: true }),
  });
  apply(ctx, undefined);
  await settle();
  assert.deepEqual(writes, []);
  assert.deepEqual(unsets, [DEFAULT_REF]);
});

test('apply: a signed-out session with no key on disk writes nothing at all', async () => {
  const { ctx, writes, unsets } = makeContext({ session: () => null });
  apply(ctx, undefined);
  await settle();
  assert.deepEqual(writes, []);
  assert.deepEqual(unsets, [], 'deleting an absent credential would rewrite the file for nothing');
});

test('apply: an unauthorized session drops the key, an unreachable server keeps it', async () => {
  // Both contexts model a key left on disk by a previous run, so the delete is the
  // behaviour under test rather than the "nothing stored" short-circuit.
  const stale = async () => ({ configured: true, writable: true });
  const unauthorized = makeContext({
    session: () => ({ origin: 'https://www.czmanong.com', token: 't', userId: null }),
    describe: stale,
  });
  const unreachable = makeContext({
    session: () => ({ origin: 'https://www.czmanong.com', token: 't', userId: null }),
    describe: stale,
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => respond(401, {});
    apply(unauthorized.ctx, undefined);
    await settle();
    globalThis.fetch = async () => respond(503, {});
    apply(unreachable.ctx, undefined);
    await settle();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(unauthorized.unsets, [DEFAULT_REF]);
  assert.deepEqual(unreachable.unsets, [], 'a 503 says nothing about whether the gateway key is still valid');
  assert.deepEqual(unreachable.writes, []);
  assert.ok(unreachable.logged.some(([level]) => level === 'warn'));
});

test('apply: a session whose origin is overridden asks the override, not the account origin', async () => {
  const { ctx } = makeContext({
    session: () => ({ origin: 'https://platform.example.test', token: 'session-jwt', userId: null }),
  });
  const seen = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      seen.push(url);
      return respond(200, { ok: true, access: { apiKey: 'sk-local' } });
    };
    // Local development points the product server at a loopback origin while the
    // account session still names the deployed one.
    apply(ctx, { origin: 'http://127.0.0.1:13090' });
    await settle();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(seen, [`http://127.0.0.1:13090${MODEL_ACCESS_PATH}`]);
});

test('apply: enabled:false does nothing and says so once', () => {
  const { ctx, writes, logged } = makeContext({ session: () => null });
  apply(ctx, { enabled: false });
  assert.deepEqual(writes, []);
  assert.ok(logged.some(([level, message]) => level === 'warn' && message.includes('已关闭')));
});

test('apply: the plugin is named and injected for the two services it uses', async () => {
  // Cordis identifies the fiber and its disposal by `name`; a rename would orphan
  // the effect. The exact inject list is asserted because a missing `credentials`
  // makes the write silently impossible while the plugin still loads.
  const module = await import('./model-key.mjs');
  assert.equal(name, 'dsharness-model-key');
  assert.deepEqual(module.inject, ['deepseekAccount', 'credentials']);
});
