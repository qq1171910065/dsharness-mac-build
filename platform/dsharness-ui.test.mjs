import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

/**
 * `dsharness` 组合包的浏览器半（`dsharness-ui.js`）。
 *
 * 这一层最容易悄悄错的三件事，都在下面**真求值**验，而不是拿源码做字符串比对：
 *
 * 1. 注册 `id` 必须逐字符等于包名 —— 加载器按 `id` 对账，不一致时整个 bundle 被丢弃
 *    （`packages/client/modules/src/client/system.ts:164-178` 的 register 只认 id）；
 * 2. bundle 是**经典脚本**：它由 `document.createElement('script')` 执行，
 *    所以只能通过 `window.__ModuleLoader__.load({ id, factory })` 注册自己的工厂，
 *    不能有 `import`/`export`。这里在 vm 里当脚本跑一遍就是证明；
 * 3. 只读面板**绝不能把密钥画出来**：下面用一个「投毒」状态体（多带 `token` /
 *    `secret` / `apiKey` / `modelKey.value`）加一个记录属性读取的 Proxy 证明 ——
 *    那些字段**根本没被读**，所以不可能被画出来。
 *
 * 这一层只允许要基线模块（`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`）：
 * 白名单被钉在 `require` 桩里，想接 `dsh-client-locale` 会当场抛错。
 */

const here = import.meta.dirname;
/** bundle 的每一行；「毒值只存在于用例里」那条断言拿它做对照。 */
const BUNDLE_FILE = 'dsharness-ui.js';
const bundle = readFileSync(join(here, BUNDLE_FILE), 'utf8');
const BUNDLE_LINES = bundle.split('\n');

/** 允许被 require 的基线（本 bundle 只该用前两个）。 */
const BASELINE = new Set(['react', 'react/jsx-runtime']);

/** 宿主半钉死的只读状态契约（`/dsharness/status.json`）。 */
const STATUS = {
  ok: true,
  port: 13094,
  address: 'http://127.0.0.1:13094',
  tokenConfigured: true,
  cookieName: 'dsharness_auth',
  loginPath: '/dsharness/auth',
  gatewayPath: '/dsharness/gateway',
  version: { current: '0.2.1-alpha.1', latest: '0.2.2', updateAvailable: true },
  modelKey: { ref: 'DSHARNESS_MODEL_KEY', configured: true },
  account: {
    signedIn: true,
    name: '阿农',
    contact: 'someone@example.test',
    balance: [{ currency: 'CNY', balance: '12.34' }],
  },
  checkedAt: '2026-10-08T01:00:00.000Z',
};

/** 一个够用的 `react` 桩（hook 槽位按固定顺序，effect 由用例显式触发）。 */
function reactStub() {
  const state = [];
  const refs = [];
  const effects = [];
  const setters = [];
  let cursor = 0;
  return {
    state,
    refs,
    effects,
    setters,
    /**
     * 按固定 hook 顺序渲染一次；`effects` 每次渲染清空，由用例显式调用。
     * @param Component - 被测组件。
     * @param props - owner props（页面给的那一份）。
     * @returns 元素树。
     */
    render(Component, props = {}) {
      cursor = 0;
      effects.length = 0;
      return Component(props);
    },
    api: {
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
        const set = (updater) => {
          state[index] = typeof updater === 'function' ? updater(state[index]) : updater;
          setters.push(state[index]);
        };
        return [state[index], set];
      },
      useRef(value) {
        const index = cursor++;
        if (!(index in refs)) refs[index] = { current: value };
        return refs[index];
      },
      useEffect(effect) { effects.push(effect); },
    },
  };
}

/** 一个 200 响应；`payload` 原样交给 `json()`。 */
function response(payload) {
  return { ok: true, json: () => Promise.resolve(payload) };
}

/**
 * 在假 `window.__ModuleLoader__` 上把 bundle 当**经典脚本**真跑一遍。
 * @param globals - 写进 vm 全局的东西（`dshDesktop` / `navigator` / `document` / `fetch` / `location`）。
 * @returns 记下来的注册、require 过的模块、react 桩、插件命名空间与 fetch/定时器记录。
 */
function evaluate(globals = {}) {
  const registrations = [];
  const fetched = [];
  const timers = [];
  const cleared = [];
  const timeouts = [];
  const clearedTimeouts = [];
  const clipboardWrites = [];
  const handler = globals.fetch ?? (() => Promise.resolve(response(STATUS)));
  /*
   * 剪贴板默认就有一个能用的桩：复制按钮的行为要**真**验，而不是靠「没有 clipboard
   * 所以走失败分支」蒙对。`clipboard: null` 表达「这个环境没有它」；也可以在
   * `navigator.clipboard` 上自己给一个写失败的桩。
   */
  const clipboard = globals.clipboard === null
    ? null
    : globals.clipboard ?? { writeText: (text) => { clipboardWrites.push(String(text)); return Promise.resolve(); } };
  const baseNavigator = globals.navigator === null ? undefined : globals.navigator ?? { language: 'zh-CN' };
  const sandbox = {
    // `navigator: null` / `document: null` 表示「这个 vm 里根本没有它」。
    navigator: baseNavigator === undefined ? undefined : { clipboard, ...baseNavigator },
    document: globals.document === null ? undefined : globals.document,
    dshDesktop: globals.dshDesktop,
    location: globals.location ?? { origin: 'http://127.0.0.1:13094' },
    console,
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearInterval(id) { cleared.push(id); },
    setTimeout(fn, ms) { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout(id) { clearedTimeouts.push(id); },
    window: {
      __ModuleLoader__: {
        load(registration) { registrations.push(registration); },
      },
    },
  };
  if (globals.fetch !== null) {
    sandbox.fetch = (url) => { fetched.push(String(url)); return handler(url); };
  }
  const context = createContext(sandbox);
  runInContext(bundle, context, { filename: BUNDLE_FILE });
  assert.equal(registrations.length, 1, 'the bundle must register exactly one factory');
  const registration = registrations[0];
  const required = [];
  const react = reactStub();
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
  };
  const namespace = registration.factory((specifier) => {
    required.push(specifier);
    if (!BASELINE.has(specifier)) throw new Error(`bundle required a non-baseline module: ${specifier}`);
    return specifier === 'react' ? react.api : jsxRuntime;
  });
  return {
    registration, namespace, required, react, fetched, timers, cleared,
    timeouts, clearedTimeouts, clipboardWrites,
  };
}

/** 记录 `slots.inject` / `slots.register` 参数的桩上下文。 */
function slotContext() {
  const registrations = [];
  const injections = [];
  return {
    registrations,
    injections,
    ctx: {
      slots: {
        inject(name, callback) { injections.push(name); return callback(); },
        register(options, component) { registrations.push({ options, component }); return () => {}; },
      },
    },
  };
}

/**
 * 把两个注册装好并返回 `{ Panel, Row }`。
 * @param globals - 传给 {@link evaluate} 的 vm 全局。
 * @returns 被测组件与它的 evaluate 结果。
 */
function mounted(globals = {}) {
  const run = evaluate(globals);
  const slots = slotContext();
  run.namespace.apply(slots.ctx);
  assert.equal(slots.registrations.length, 2);
  return { ...run, Panel: slots.registrations[0].component, Row: slots.registrations[1].component, slots };
}

/** 对象树里所有字符串拼起来，便于断言「用户能看到这句话」。 */
function visible(node) {
  if (typeof node === 'string') return node;
  if (node === null || typeof node !== 'object') return '';
  const children = node.props === undefined ? undefined : node.props.children;
  if (children === undefined || children === null) return '';
  return (Array.isArray(children) ? children : [children]).map(visible).join(' ');
}

/** 对象树里所有该类型的节点。 */
function findAll(node, type, found = []) {
  if (node === null || typeof node !== 'object') return found;
  if (node.type === type) found.push(node);
  const children = node.props === undefined ? undefined : node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) findAll(child, type, found);
  return found;
}

/** 所有带 `data-dsharness-component` 的组件行。 */
function componentRows(node, found = []) {
  if (node === null || typeof node !== 'object') return found;
  const marker = node.props === undefined ? undefined : node.props['data-dsharness-component'];
  if (typeof marker === 'string') found.push(marker);
  const children = node.props === undefined ? undefined : node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) componentRows(child, found);
  return found;
}

/** 某一个组件的复制按钮（`data-dsharness-copy` 就是它的组件键）。 */
function copyButton(tree, key) {
  return findAll(tree, 'button').find((node) => node.props['data-dsharness-copy'] === key);
}

/**
 * 更新按钮 —— 唯一**没有** `data-dsharness-copy` 的按钮。
 *
 * 面板现在有三个按钮（两个复制 + 一个更新），所以「第 0 个按钮」不再是更新按钮；
 * 用它来定位，改按钮顺序时不会悄悄测错对象。
 */
function updateButton(tree) {
  return findAll(tree, 'button').find((node) => node.props['data-dsharness-copy'] === undefined);
}

/** 一条组件的渲染文本（按 `data-dsharness-component` 定位）。 */
function componentText(node, key) {
  if (node === null || typeof node !== 'object') return '';
  if (node.props !== undefined && node.props['data-dsharness-component'] === key) return visible(node);
  const children = node.props === undefined ? undefined : node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = componentText(child, key);
    if (hit !== '') return hit;
  }
  return '';
}

/** 刷新微任务队列（fetch 链有 3-4 跳）。 */
async function settle() {
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
}

/** 递归包一层 Proxy，记录被读到的属性路径。 */
function watch(value, reads, path = '') {
  if (value === null || typeof value !== 'object') return value;
  return new Proxy(value, {
    get(target, property, receiver) {
      if (typeof property === 'string') reads.push(path === '' ? property : `${path}.${property}`);
      const result = Reflect.get(target, property, receiver);
      return result !== null && typeof result === 'object' ? watch(result, reads, path === '' ? property : `${path}.${property}`) : result;
    },
  });
}

test('bundle：用假 window 真求值，注册 id 等于包名 dsharness，且只 require 基线模块', () => {
  const { registration, namespace, required } = evaluate();
  // `id` 必须逐字符等于包名：加载器按它对账，不一致时整个 bundle 被丢弃。
  assert.equal(registration.id, 'dsharness');
  assert.deepEqual([...new Set(required)].sort(), ['react', 'react/jsx-runtime']);
  assert.equal(typeof namespace.apply, 'function');
  // vm 里造出来的数组有另一个 realm 的 Array 原型，所以逐元素比。
  assert.equal(namespace.inject.length, 1);
  assert.equal(namespace.inject[0], 'slots');
  // 经典脚本不能有 import/export，第一条语句就是加载器门面。
  assert.ok(!/^\s*(?:import|export)\s/m.test(bundle), 'a classic script cannot use import/export');
  assert.match(bundle, /^window\.__ModuleLoader__\.load\(\{$/mu);
});

test('apply：两处注册 —— 卡片面板 key=dsharness，通用设置行 id=dsharness order=90', () => {
  const { namespace } = evaluate();
  const { ctx, registrations, injections } = slotContext();
  namespace.apply(ctx);
  assert.equal(injections.length, 2);
  assert.equal(injections[0], 'plugins.bundle.config');
  assert.equal(injections[1], 'settings.general.item');
  assert.equal(registrations.length, 2);

  const panel = registrations[0].options;
  assert.equal(panel.name, 'plugins.bundle.config');
  // key 必须等于包名：`config-ledger.ts:52/66` 用它决定卡片是否渲染配置区，
  // 渲染点 `PluginManagerPage.tsx:680` 传的 entryKey 就是 pkg.name。
  assert.equal(panel.key, 'dsharness');
  assert.deepEqual({ ...panel }, { name: 'plugins.bundle.config', key: 'dsharness' });
  assert.equal(typeof registrations[0].component, 'function');

  const row = registrations[1].options;
  assert.equal(row.name, 'settings.general.item');
  assert.equal(row.id, 'dsharness');
  // 夹在 developer-tools(15) 与 current-version(100) 之间（ui-settings-general/index.ts:76/84）。
  assert.equal(row.order, 90);
  assert.equal(typeof row.label, 'function');
  assert.equal(row.label(), '检查更新');
  // 不声明 locale：这一层自带中英文案；声明了框架会去找一个没人注册过的命名空间。
  assert.equal('locale' in panel, false);
  assert.equal('locale' in row, false);
  assert.equal('inject' in panel, false);
});

test('面板 { view: "page" }：四个组件行 + 端口 + 地址 + 只读', async () => {
  const { react, Panel } = mounted();
  // 页面就是这么传的：`renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`。
  react.render(Panel, { view: 'page' });
  assert.equal(react.effects.length, 4, 'status + update + the two copy hooks');
  react.effects[0]();
  react.effects[1]();
  await settle();
  const tree = react.render(Panel, { view: 'page' });
  assert.deepEqual(componentRows(tree), ['gateway', 'modelKey', 'update', 'account']);
  // 面板自己的表头。
  assert.match(visible(tree), /码农 DSH/);
  assert.match(visible(tree), /本产品自带的插件/);
  // 「要显示当前 dsh 运行的端口等等」。
  assert.match(componentText(tree, 'gateway'), /本机网关/);
  assert.match(componentText(tree, 'gateway'), /运行中/);
  assert.match(componentText(tree, 'gateway'), /监听端口 13094/);
  assert.match(componentText(tree, 'gateway'), /本机地址 http:\/\/127\.0\.0\.1:13094/);
  // 共享密钥只说配没配。
  assert.match(componentText(tree, 'gateway'), /共享密钥：已配置/);
  // 凭据名是常量，值不出现。
  assert.match(componentText(tree, 'modelKey'), /凭据名：DSHARNESS_MODEL_KEY/);
  assert.match(componentText(tree, 'modelKey'), /已同步/);
  assert.match(componentText(tree, 'update'), /有新版本 0\.2\.2/);
  assert.match(componentText(tree, 'update'), /当前版本 0\.2\.1-alpha\.1/);
  // 「登录之后就能同步到用户的key，并且获取费用等信息」：钱按钱包逐条显示。
  assert.match(componentText(tree, 'account'), /已登录/);
  assert.match(componentText(tree, 'account'), /阿农/);
  assert.match(componentText(tree, 'account'), /余额：¥12\.34/);
  // 可写控件只有三个按钮：两行的「复制」与「检查更新」。没有充值按钮，也没有输入框。
  assert.deepEqual(
    findAll(tree, 'button').map((node) => node.props['data-dsharness-copy'] ?? 'update'),
    ['gateway', 'modelKey', 'update'],
  );
  assert.equal(copyButton(tree, 'gateway').props.children, '复制');
  assert.equal(copyButton(tree, 'modelKey').props.children, '复制');
  assert.equal(copyButton(tree, 'gateway').props.disabled, false);
  assert.equal(copyButton(tree, 'modelKey').props.disabled, false);
  assert.equal(findAll(tree, 'input').length, 0);
  assert.equal(findAll(tree, 'select').length, 0);
  assert.equal(findAll(tree, 'textarea').length, 0);
  assert.ok(!visible(tree).includes('充值'));
});

test('面板 { view: "summary" }：只回一行字，不画面板也不挂载', () => {
  const zh = mounted();
  const summary = zh.react.render(zh.Panel, { view: 'summary' });
  assert.equal(typeof summary, 'string');
  assert.match(summary, /本机网关/);
  assert.match(summary, /账号与费用/);
  // summary 是卡片一句话，不该带任何事实。
  assert.ok(!summary.includes('13094'));
  const en = mounted({ navigator: { language: 'en-US' } });
  assert.match(en.react.render(en.Panel, { view: 'summary' }), /Local gateway/);
  // 没有 owner props（`form` 可缺席）也不抛。
  assert.doesNotThrow(() => zh.react.render(zh.Panel));
});

test('面板：未配置 / 未登录 / 已是最新；读不到时降级为「状态暂时读不到」', async () => {
  const off = {
    ok: true,
    port: 13094,
    address: 'http://127.0.0.1:13094',
    tokenConfigured: false,
    token: 'must-never-render',
    modelKey: { ref: 'DSHARNESS_MODEL_KEY', configured: false, value: 'must-never-render-either' },
    version: { current: '0.2.1', latest: '0.2.1', updateAvailable: false },
    account: { signedIn: false, name: null, contact: null, balance: [] },
  };
  const { react, Panel } = mounted({ fetch: () => Promise.resolve(response(off)) });
  react.render(Panel, { view: 'page' });
  react.effects[0]();
  await settle();
  const tree = react.render(Panel, { view: 'page' });
  assert.match(componentText(tree, 'gateway'), /未启用/);
  assert.match(componentText(tree, 'gateway'), /共享密钥：未配置/);
  assert.match(componentText(tree, 'modelKey'), /未登录/);
  assert.match(componentText(tree, 'modelKey'), /未配置/);
  assert.match(componentText(tree, 'update'), /已是最新/);
  assert.match(componentText(tree, 'account'), /未登录/);
  assert.ok(!visible(tree).includes('must-never-render'));

  // 读不到：可见提示 + 四个行照常 + 状态说「未知」，而不是假装可用。
  const broken = mounted({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
  broken.react.render(broken.Panel, { view: 'page' });
  broken.react.effects[0]();
  await settle();
  const degraded = broken.react.render(broken.Panel, { view: 'page' });
  assert.match(visible(degraded), /状态暂时读不到/);
  assert.deepEqual(componentRows(degraded), ['gateway', 'modelKey', 'update', 'account']);
  assert.match(componentText(degraded, 'gateway'), /未知/);
  // 面板头部照常，降级只影响事实。
  assert.match(visible(degraded), /码农 DSH/);
});

test('降级：403 / 网络错误 / 不是对象 / 没有 fetch，一律不抛', async () => {
  const failures = [
    ['403', () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) })],
    ['网络错误', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['不是对象', () => Promise.resolve(response('nope'))],
    ['json() 抛', () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('bad json')) })],
  ];
  for (const [name, handler] of failures) {
    const { react, Panel } = mounted({ fetch: handler });
    assert.doesNotThrow(() => react.render(Panel, { view: 'page' }), name);
    assert.doesNotThrow(() => { react.effects[0](); }, name);
    await settle();
    const tree = react.render(Panel, { view: 'page' });
    assert.match(visible(tree), /状态暂时读不到/, name);
    assert.deepEqual(componentRows(tree), ['gateway', 'modelKey', 'update', 'account'], name);
  }
  // 整个 vm 里没有 fetch：也只降级，不抛。
  const noFetch = mounted({ fetch: null });
  noFetch.react.render(noFetch.Panel, { view: 'page' });
  assert.doesNotThrow(() => noFetch.react.effects[0]());
  await settle();
  assert.match(visible(noFetch.react.render(noFetch.Panel, { view: 'page' })), /状态暂时读不到/);
});

test('降级：状态体缺字段（或类型不对）时逐条取默认，不抛', async () => {
  const { react, Panel } = mounted({ fetch: () => Promise.resolve(response({ ok: true, tokenConfigured: 'yes' })) });
  react.render(Panel, { view: 'page' });
  react.effects[0]();
  await settle();
  const tree = react.render(Panel, { view: 'page' });
  // 只有 `ok: true` 也必须能画：类型不对的 `tokenConfigured` 不算配置。
  assert.deepEqual(componentRows(tree), ['gateway', 'modelKey', 'update', 'account']);
  assert.match(componentText(tree, 'gateway'), /未启用/);
  assert.match(componentText(tree, 'gateway'), /共享密钥：未配置/);
  // 契约规定：`account` 缺席（服务不在）降级成 `signedIn: false`。
  assert.match(componentText(tree, 'modelKey'), /未登录/);
  assert.match(componentText(tree, 'modelKey'), /未配置/);
  assert.match(componentText(tree, 'update'), /尚未检查/);
  assert.match(componentText(tree, 'update'), /当前版本 —/);
  assert.match(componentText(tree, 'account'), /未登录/);
});

test('只读：状态面里的密钥与 Key 值根本没被读，所以不可能被画出来', async () => {
  /*
   * 两层证明：
   * 1. 结构层 —— 状态体的属性读取被 Proxy 全量记录，读取集合里没有任何
   *    密钥类字段，且顶层只读契约里的展示字段确实被读了（不是空集）；
   * 2. 渲染层 —— 一个「投毒」状态体（多带 token/secret/apiKey/modelKey.value）
   *    渲染出来的文字里不含那些值。
   *
   * ⚠️ 复制按钮读的是**另一个面**（`/dsharness/secret.json`，按需），所以这条
   * 只说明状态面不泄值；按钮那一路由下面「复制」那条用例证明。
   */
  const reads = [];
  const poison = {
    ...STATUS,
    token: 'super-secret-token-value',
    secret: 'shared-secret-value',
    apiKey: 'sk-poison-api-key',
    modelKey: { ref: 'DSHARNESS_MODEL_KEY', configured: true, value: 'sk-poison-model-key' },
  };
  const payload = watch(poison, reads);
  const { react, Panel } = mounted({ fetch: () => Promise.resolve(response(payload)) });
  react.render(Panel, { view: 'page' });
  react.effects[0]();
  await settle();
  const text = visible(react.render(Panel, { view: 'page' }));
  for (const poisonValue of ['super-secret-token-value', 'shared-secret-value', 'sk-poison-api-key', 'sk-poison-model-key']) {
    assert.ok(!text.includes(poisonValue), `rendered output must not contain ${poisonValue}`);
    for (const line of BUNDLE_LINES) {
      assert.ok(!line.includes(poisonValue), 'sanity: the poison values only exist in the test payload');
    }
  }
  // 结构性证明：没被读到的属性，就不可能被渲染。
  const names = [...new Set(reads.map((path) => path.split('.').pop()))];
  for (const forbidden of ['token', 'secret', 'apiKey', 'value', 'password', 'cookieName']) {
    assert.ok(!names.includes(forbidden), `the status face must never read "${forbidden}" (reads: ${reads.join(', ')})`);
  }
  // 顶层只读契约（不加不减）：读了这些，才说明上面那条不是空集。
  // `then` 是 `Promise.resolve(...).then` 读到的，不是状态体字段。
  const top = [...new Set(reads.map((path) => path.split('.')[0]))].filter((name) => name !== 'then');
  assert.deepEqual(top.sort(), ['account', 'address', 'modelKey', 'port', 'tokenConfigured', 'version']);
  assert.ok(reads.includes('tokenConfigured'));
  assert.ok(reads.includes('modelKey.configured'));
  assert.ok(reads.includes('account.signedIn'));
  assert.ok(reads.includes('account.balance'));
  assert.ok(reads.includes('version.updateAvailable'));

  /*
   * 静态对照 —— 状态面那一路：**没有一次点击**时，bundle 里不该有任何读取凭据
   * 值的写法被走到。能做的是钉住「按需取值只出现在点击处理器里」：
   * 取值的两个选择函数只在 `readSecret` 的调用点出现，而唯一的调用点是 `useCopy`
   * 的点击处理器。取值面路径也必须是常量，不能拼出来。
   */
  assert.match(bundle, /const SECRET_PATH = '\/dsharness\/secret\.json'/u);
  // 两个组件的取值各自只有一个调用点，且都挂在复制 hook 上（值不进渲染）。
  assert.equal((bundle.match(/useCopy\((?:gatewaySecret|modelKeySecret),/gu) ?? []).length, 2);
  // 一个定义、一个调用点（都在复制 hook 里）：值不会被别的路径读到。
  assert.equal((bundle.match(/function readSecret\(pick\)/gu) ?? []).length, 1);
  assert.equal((bundle.match(/then\(\(\) => readSecret\(pick\)\)/gu) ?? []).length, 1);
  // 按钮点击之外没有任何地方请求取值面：两个 URL 都只由各自的函数拼装，
  // 而 `request(secretUrl())` 只在那一个调用点出现。
  assert.ok(bundle.includes('request(statusUrl())'), 'the polled face has its own fetch');
  assert.equal((bundle.match(/request\(secretUrl\(\)\)/gu) ?? []).length, 1, 'the value face is fetched from exactly one place');
  assert.ok(!/^\s*(?:import|export)\s/m.test(bundle), 'still a classic script');
});

test('复制：两行各有一个按钮，点击把取值面里的值交给剪贴板，并显示「已复制」', async () => {
  /*
   * 用户口径：「本机网关一行右侧要有复制密钥的按钮，点击之后复制共享密钥」
   * 「模型 key 也是，要有复制 key 的按钮」。
   *
   * 真跑一遍点击：fetch 桩按 URL 分流 —— 状态面回状态，取值面回两个值；
   * 剪贴板桩记录写进去的文字。断言「值到了剪贴板」与「值没进渲染树」同时在。
   */
  const GATEWAY_SECRET = 'gateway-secret-value-never-rendered';
  const MODEL_KEY = 'sk-model-key-value-never-rendered';
  const fetchStub = (url) => Promise.resolve(response(String(url).endsWith('/dsharness/secret.json')
    ? { ok: true, gateway: { token: GATEWAY_SECRET }, modelKey: { ref: 'DSHARNESS_MODEL_KEY', value: MODEL_KEY } }
    : STATUS));
  const { react, Panel, fetched, clipboardWrites, timeouts } = mounted({ fetch: fetchStub });
  react.render(Panel, { view: 'page' });
  react.effects[0]();
  await settle();
  const tree = react.render(Panel, { view: 'page' });
  assert.deepEqual(fetched, ['http://127.0.0.1:13094/dsharness/status.json'], 'mounting must not read the values');

  copyButton(tree, 'gateway').props.onClick();
  await settle();
  assert.deepEqual(fetched, [
    'http://127.0.0.1:13094/dsharness/status.json',
    'http://127.0.0.1:13094/dsharness/secret.json',
  ], 'the click is what reads the value face');
  assert.deepEqual(clipboardWrites, [GATEWAY_SECRET]);
  // 短暂确认：2s 之后自己消失。
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, 2000);
  let notice = react.render(Panel, { view: 'page' });
  assert.match(componentText(notice, 'gateway'), /已复制/);
  assert.ok(!componentText(notice, 'modelKey').includes('已复制'), 'only the clicked row confirms');
  timeouts[0].fn();
  notice = react.render(Panel, { view: 'page' });
  assert.ok(!visible(notice).includes('已复制'), 'the confirmation is transient');

  copyButton(notice, 'modelKey').props.onClick();
  await settle();
  assert.deepEqual(clipboardWrites, [GATEWAY_SECRET, MODEL_KEY]);
  assert.match(componentText(react.render(Panel, { view: 'page' }), 'modelKey'), /已复制/);

  // 两个值都没有渲染路径：整棵树里没有它们。
  const text = visible(react.render(Panel, { view: 'page' }));
  assert.ok(!text.includes(GATEWAY_SECRET));
  assert.ok(!text.includes(MODEL_KEY));
});

test('复制：失败路径说「复制失败」—— 响应缺值 / 网络错误 / 没有剪贴板', async () => {
  const variants = [
    ['取值面回 null', { ok: true, gateway: { token: null }, modelKey: { ref: 'DSHARNESS_MODEL_KEY', value: null } }],
    ['响应形状不认识', { ok: true }],
  ];
  for (const [name, payload] of variants) {
    const { react, Panel, clipboardWrites } = mounted({
      fetch: (url) => Promise.resolve(response(String(url).endsWith('/dsharness/secret.json') ? payload : STATUS)),
    });
    react.render(Panel, { view: 'page' });
    react.effects[0]();
    await settle();
    const tree = react.render(Panel, { view: 'page' });
    tree; // 状态面说 tokenConfigured/configured 都为真，所以按钮可用。
    copyButton(react.render(Panel, { view: 'page' }), 'gateway').props.onClick();
    await settle();
    assert.match(componentText(react.render(Panel, { view: 'page' }), 'gateway'), /复制失败/, name);
    assert.deepEqual(clipboardWrites, [], name);
  }

  // 网络错误：一样只降级成「复制失败」，绝不抛。
  const broken = mounted({
    fetch: (url) => (String(url).endsWith('/dsharness/secret.json')
      ? Promise.reject(new Error('ECONNREFUSED'))
      : Promise.resolve(response(STATUS))),
  });
  broken.react.render(broken.Panel, { view: 'page' });
  broken.react.effects[0]();
  await settle();
  assert.doesNotThrow(() => copyButton(broken.react.render(broken.Panel, { view: 'page' }), 'gateway').props.onClick());
  await settle();
  assert.match(componentText(broken.react.render(broken.Panel, { view: 'page' }), 'gateway'), /复制失败/);

  // 没有 navigator.clipboard（非安全上下文就是这种形态）：同样的失败文案，不抛。
  const noClipboard = mounted({ clipboard: null });
  noClipboard.react.render(noClipboard.Panel, { view: 'page' });
  noClipboard.react.effects[0]();
  await settle();
  assert.doesNotThrow(() => copyButton(noClipboard.react.render(noClipboard.Panel, { view: 'page' }), 'gateway').props.onClick());
  await settle();
  assert.match(componentText(noClipboard.react.render(noClipboard.Panel, { view: 'page' }), 'gateway'), /复制失败/);
  assert.deepEqual(noClipboard.clipboardWrites, []);

  // 剪贴板写失败（权限被拒）：也是「复制失败」。
  const denied = mounted({ clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } });
  denied.react.render(denied.Panel, { view: 'page' });
  denied.react.effects[0]();
  await settle();
  copyButton(denied.react.render(denied.Panel, { view: 'page' }), 'gateway').props.onClick();
  await settle();
  assert.match(componentText(denied.react.render(denied.Panel, { view: 'page' }), 'gateway'), /复制失败/);
});

test('复制：值已知缺席时按钮禁用，点击不发请求', async () => {
  /*
   * 宿主半已经在状态面里说了「这一项没有值」（`tokenConfigured` / `configured`
   * 不为真）。那时候按钮禁用：点下去只会有一次注定失败的请求，而用户会把它读成
   * 「复制功能坏了」。
   */
  const off = {
    ok: true,
    port: 13094,
    address: 'http://127.0.0.1:13094',
    tokenConfigured: false,
    modelKey: { ref: 'DSHARNESS_MODEL_KEY', configured: false },
    version: { current: '0.2.1', latest: '0.2.1', updateAvailable: false },
    account: { signedIn: true, name: '阿农', contact: null, balance: [] },
  };
  const { react, Panel, fetched } = mounted({ fetch: () => Promise.resolve(response(off)) });
  react.render(Panel, { view: 'page' });
  react.effects[0]();
  await settle();
  const tree = react.render(Panel, { view: 'page' });
  const gateway = copyButton(tree, 'gateway');
  const key = copyButton(tree, 'modelKey');
  assert.equal(gateway.props.disabled, true);
  assert.equal(key.props.disabled, true);
  // 按钮仍在（用户看得见这一行有复制能力），只是不可点。
  assert.equal(gateway.props.children, '复制');
  assert.equal(key.props.children, '复制');
  gateway.props.onClick();
  key.props.onClick();
  await settle();
  assert.deepEqual(fetched, ['http://127.0.0.1:13094/dsharness/status.json'], 'a disabled copy must not fetch');
  assert.ok(!visible(tree).includes('已复制'));

  // 状态没读到时同样禁用：还不知道有没有值，就不该让用户点。
  const reading = mounted();
  const readingTree = reading.react.render(reading.Panel, { view: 'page' });
  assert.equal(copyButton(readingTree, 'gateway').props.disabled, true);
  assert.equal(copyButton(readingTree, 'modelKey').props.disabled, true);
});

test('复制：英文界面下的按钮与确认走英文文案', async () => {
  const { react, Panel, clipboardWrites } = mounted({
    navigator: { language: 'en-US' },
    fetch: (url) => Promise.resolve(response(String(url).endsWith('/dsharness/secret.json')
      ? { ok: true, gateway: { token: 'secret' }, modelKey: { ref: 'DSHARNESS_MODEL_KEY', value: 'sk-key' } }
      : STATUS)),
  });
  react.render(Panel, { view: 'page' });
  react.effects[0]();
  await settle();
  let tree = react.render(Panel, { view: 'page' });
  assert.equal(copyButton(tree, 'gateway').props.children, 'Copy');
  copyButton(tree, 'gateway').props.onClick();
  await settle();
  tree = react.render(Panel, { view: 'page' });
  assert.match(componentText(tree, 'gateway'), /Copied/);
  assert.deepEqual(clipboardWrites, ['secret']);
});

test('复制：纯浏览器（没有 dshDesktop）下两个按钮照常可用', async () => {
  /*
   * 用户真正会点到的那个形态就是**浏览器 / Web profile**：复制按钮只用
   * `fetch` + `navigator.clipboard`，与桌面端的 preload 桥毫无关系。所以它不能像
   * 「检查更新」那样 `disabled = updates === undefined` —— 那条路在浏览器里根本没有。
   * 这条用例把这一点钉死：`dshDesktop` 缺席时，两个复制按钮仍可用、仍能取值。
   */
  const GATEWAY_SECRET = 'browser-mode-gateway-secret';
  const MODEL_KEY = 'sk-browser-mode-model-key';
  const { react, Panel, clipboardWrites } = mounted({
    // 没有 dshDesktop 这一面：面板上唯一的「更新」按钮会被禁用，复制按钮不该。
    fetch: (url) => Promise.resolve(response(String(url).endsWith('/dsharness/secret.json')
      ? { ok: true, gateway: { token: GATEWAY_SECRET }, modelKey: { ref: 'DSHARNESS_MODEL_KEY', value: MODEL_KEY } }
      : STATUS)),
  });
  react.render(Panel, { view: 'page' });
  react.effects[0]();
  await settle();
  const tree = react.render(Panel, { view: 'page' });

  assert.equal(copyButton(tree, 'gateway').props.disabled, false, 'a browser must still be able to copy the secret');
  assert.equal(copyButton(tree, 'modelKey').props.disabled, false, 'a browser must still be able to copy the model key');
  // 同一个面板里的「检查更新」在浏览器里就是禁用的（那一面确实需要桌面壳）——
  // 对比之下才说明复制按钮的启用条件与 dshDesktop 无关。
  assert.equal(updateButton(tree).props.disabled, true);

  copyButton(tree, 'gateway').props.onClick();
  copyButton(tree, 'modelKey').props.onClick();
  await settle();
  assert.deepEqual(clipboardWrites, [GATEWAY_SECRET, MODEL_KEY]);
  const text = visible(react.render(Panel, { view: 'page' }));
  assert.ok(!text.includes(GATEWAY_SECRET) && !text.includes(MODEL_KEY));
  // 静态对照：复制按钮的禁用条件只读状态面那两个布尔，从不碰 dshDesktop。
  assert.ok(!/disabled:\s*[^,\n]*bridge\(\)/u.test(bundle), 'the copy buttons must not be gated on the desktop bridge');
});

test('复制：点击后卸载不再写状态，定时器被清掉', async () => {
  const { react, Panel, timeouts, clearedTimeouts } = mounted({
    fetch: (url) => Promise.resolve(response(String(url).endsWith('/dsharness/secret.json')
      ? { ok: true, gateway: { token: 'secret' }, modelKey: { ref: 'DSHARNESS_MODEL_KEY', value: 'sk-key' } }
      : STATUS)),
  });
  react.render(Panel, { view: 'page' });
  const disposeStatus = react.effects[0]();
  react.effects[1]();
  const disposeGatewayCopy = react.effects[2]();
  const disposeKeyCopy = react.effects[3]();
  await settle();
  copyButton(react.render(Panel, { view: 'page' }), 'gateway').props.onClick();
  await settle();
  const writes = react.setters.length;
  assert.equal(timeouts.length, 1);
  disposeGatewayCopy();
  disposeKeyCopy();
  disposeStatus();
  assert.equal(clearedTimeouts.length, 1, 'a disposed panel must not leave a timer behind');
  timeouts[0].fn();
  assert.equal(react.setters.length, writes, 'no state write after unmount');
});

test('轮询：挂载时读一次、每 10s 再读、卸载停表；URL 相对页面 origin', async () => {
  const { react, Panel, fetched, timers, cleared } = mounted();
  react.render(Panel, { view: 'page' });
  const cleanup = react.effects[0]();
  await settle();
  assert.equal(fetched.length, 1);
  // 相对页面 origin 取，不是硬编码 host。
  assert.equal(fetched[0], 'http://127.0.0.1:13094/dsharness/status.json');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10000);
  timers[0].fn();
  await settle();
  assert.equal(fetched.length, 2);
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.equal(cleared.length, 1);
  // 卸载后到的响应不再写状态。
  const writes = react.setters.length;
  timers[0].fn();
  await settle();
  assert.equal(react.setters.length, writes);
});

test('没有 dshDesktop：两处的更新按钮都禁用并说明原因，点击不抛', () => {
  const { react, Panel, Row } = mounted();
  const tree = react.render(Panel, { view: 'page' });
  const button = updateButton(tree);
  assert.ok(button !== undefined);
  assert.equal(button.props.disabled, true);
  assert.doesNotThrow(() => button.props.onClick());
  assert.equal(react.setters.length, 0, 'a click without the bridge must be a no-op');

  const rowTree = react.render(Row);
  const rowButton = updateButton(rowTree);
  assert.equal(rowButton.props.disabled, true);
  // 说明文字必须出现，且是可读的整句。
  assert.match(visible(rowTree), /仅在桌面端可用/);
  assert.doesNotThrow(() => rowButton.props.onClick());
});

test('桌面端：订阅 + 初始状态，phase 说成人话（8 个），忙时禁用', async () => {
  const listeners = [];
  const disposers = [];
  const dshDesktop = {
    protocolVersion: 1,
    updates: {
      open: () => Promise.resolve(),
      status: () => Promise.resolve({ phase: 'idle' }),
      subscribe(listener) {
        listeners.push(listener);
        return () => { disposers.push(true); };
      },
    },
  };
  const { react, Panel } = mounted({ dshDesktop, navigator: { language: 'en-US' } });
  react.render(Panel, { view: 'page' });
  const button = updateButton(react.render(Panel, { view: 'page' }));
  assert.equal(button.props.disabled, false, 'idle is not a busy phase');
  // effect 0 是状态面，effect 1 是更新桥，2/3 是两个复制 hook；未跑之前一件事都没发生。
  assert.equal(react.effects.length, 4);
  const cleanup = react.effects[1]();
  await settle();
  assert.equal(listeners.length, 1, 'the update bridge must be subscribed');
  // 英文界面走内置英文文案（不依赖 locale 服务）。
  const phases = [
    [{ phase: 'checking' }, /Checking for updates/],
    [{ phase: 'available', version: '1.2.3' }, /Version 1\.2\.3 is available/],
    [{ phase: 'downloading', version: '1.0.0', percent: 42.4 }, /Downloading 42%/],
    [{ phase: 'verifying' }, /Verifying the downloaded installer/],
    [{ phase: 'installing' }, /Installing/],
    [{ phase: 'ready', version: '9.9.9' }, /9\.9\.9 is ready/],
    [{ phase: 'error', failure: 'download-network' }, /network is unreachable/],
    [{ phase: 'error', failure: 'unknown-reason' }, /see the Desktop dialog/],
  ];
  for (const [presentation, expected] of phases) {
    listeners[0](presentation);
    assert.match(visible(react.render(Panel, { view: 'page' })), expected);
  }
  listeners[0]({ phase: 'installing' });
  assert.equal(updateButton(react.render(Panel, { view: 'page' })).props.disabled, true, 'a busy phase disables the button');
  // 卸载：disposer 必须被调用（否则每次开插件页都漏一个 IPC 监听）。
  cleanup();
  assert.deepEqual(disposers, [true]);
  const writes = react.setters.length;
  assert.doesNotThrow(() => listeners[0]({ phase: 'available', version: '2.0.0' }));
  assert.equal(react.setters.length, writes, 'pushes after unmount must not write state');
});

test('桌面端：没有 subscribe/status 也不抛，点击调用官方 updates.open()', async () => {
  const opened = [];
  const bare = mounted({
    dshDesktop: { protocolVersion: 1, updates: { open: () => { opened.push(true); return Promise.resolve(); } } },
  });
  bare.react.render(bare.Panel, { view: 'page' });
  assert.doesNotThrow(() => bare.react.effects[1]());
  await settle();
  assert.equal(updateButton(bare.react.render(bare.Panel, { view: 'page' })).props.disabled, false);
  updateButton(bare.react.render(bare.Panel, { view: 'page' })).props.onClick();
  await settle();
  assert.deepEqual(opened, [true]);

  // open() 失败 → 状态行说「打不开更新对话框」，按钮回到可用。
  const failing = mounted({
    dshDesktop: { protocolVersion: 1, updates: { open: () => Promise.reject(new Error('nope')) } },
  });
  failing.react.render(failing.Panel, { view: 'page' });
  const tree = failing.react.render(failing.Panel, { view: 'page' });
  updateButton(tree).props.onClick();
  await settle();
  assert.match(visible(failing.react.render(failing.Panel, { view: 'page' })), /打不开更新对话框/);
});

test('设置行：同一个更新组件 —— 版本状态 + 一个按钮，点击打开对话框', async () => {
  const opened = [];
  const dshDesktop = {
    protocolVersion: 1,
    updates: {
      open: () => { opened.push(true); return Promise.resolve(); },
      status: () => Promise.resolve({ phase: 'idle' }),
      subscribe: () => () => {},
    },
  };
  const { react, Row } = mounted({ dshDesktop });
  react.render(Row);
  assert.equal(react.effects.length, 2, 'the row reads the same status face as the panel');
  react.effects[0]();
  react.effects[1]();
  await settle();
  const tree = react.render(Row);
  assert.match(visible(tree), /检查更新/);
  // 状态行带上版本结论（状态面里 current 存在、updateAvailable 为真 → 有新版本）。
  assert.match(visible(tree), /有新版本 0\.2\.2/);
  const button = updateButton(tree);
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  await settle();
  assert.deepEqual(opened, [true]);
  // 没有 dshDesktop 时说的是「仅桌面端可用」，不留空。
  const noBridge = mounted();
  noBridge.react.render(noBridge.Row);
  noBridge.react.effects[0]();
  await settle();
  assert.match(visible(noBridge.react.render(noBridge.Row)), /仅在桌面端可用/);
});

test('文案：由 navigator.language 决定，退回 <html lang>，没有 navigator 用英文', () => {
  const zh = mounted({ navigator: { language: 'zh-CN' } });
  assert.equal(zh.slots.registrations[1].options.label(), '检查更新');
  assert.match(visible(zh.react.render(zh.Panel, { view: 'page' })), /本机网关/);

  const en = mounted({ navigator: { language: 'fr-FR' } });
  assert.equal(en.slots.registrations[1].options.label(), 'Check for updates');
  assert.match(visible(en.react.render(en.Panel, { view: 'page' })), /Local gateway/);

  const fallback = mounted({ navigator: {}, document: { documentElement: { lang: 'zh-Hans' } } });
  assert.equal(fallback.slots.registrations[1].options.label(), '检查更新');

  const none = mounted({ navigator: null, document: null });
  assert.equal(none.slots.registrations[1].options.label(), 'Check for updates');
});

test('上游契约：两处注册键与页面传参的原文仍在（改了会红，而不是悄悄不渲染）', () => {
  /*
   * 这一层写的是「另一份契约」，所以钉住它的**原文**而不是凭记忆：
   * 上游把 `plugins.bundle.config` 改成别的 kind、或渲染点换了 prop 名，
   * 都应该在这里红，而不是在用户界面上静默失效。
   */
  const clientDir = join(here, '..');
  const read = (...parts) => readFileSync(join(clientDir, ...parts), 'utf8');

  const contract = read('packages', 'client', 'ui-plugin-manager', 'src', 'client', 'slot-contract.ts');
  assert.match(contract, /'plugins\.bundle\.config': \{ kind: 'keyed'; scope: 'root'; owner: PluginConfigViewProps \}/u);
  assert.match(contract, /readonly view: 'summary' \| 'page'/u);

  const page = read('packages', 'client', 'ui-plugin-manager', 'src', 'client', 'PluginManagerPage.tsx');
  // 卡片页无条件用 `{ view: 'page' }` 渲染，并用包名当 entryKey —— 所以面板不能依赖 `form`。
  assert.match(page, /renderSlot\('plugins\.bundle\.config', \{ view: 'page' \}, \{ entryKey: pkg\.name \}\)/u);
  assert.match(page, /configured=\{ledger\.bundles\.has\(openPkg\.name\)\}/u);
  const ledger = read('packages', 'client', 'ui-plugin-manager', 'src', 'client', 'config-ledger.ts');
  // `configured` 就是注册 `key` 的集合：key 必须逐字符等于包名。
  assert.match(ledger, /bundles: keysOf\('plugins\.bundle\.config'\)/u);
  assert.match(ledger, /entry\.options\.key === undefined/u);

  const settings = read('packages', 'client', 'ui-settings', 'src', 'client', 'contract', 'slots.ts');
  assert.match(settings, /'settings\.general\.item': \{ kind: 'list'; scope: 'root'; owner: SettingsGeneralItemOwnerProps \}/u);
  const general = read('packages', 'client', 'ui-settings-general', 'src', 'client', 'index.ts');
  // 90 夹在 15 与 100 之间（同一个槽位里已有这两个 id）。
  assert.match(general, /'settings\.general\.item', id: 'developer-tools', order: 15/u);
  assert.match(general, /'settings\.general\.item', id: 'current-version', order: 100/u);
});

test('ctx 上完全没有 locale 服务也不抛：这一层压根不依赖它', () => {
  const { namespace } = evaluate();
  const registrations = [];
  let localeAsked = 0;
  const ctx = {
    get() { localeAsked += 1; return undefined; },
    slots: {
      inject(name, callback) { return callback(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
  };
  assert.doesNotThrow(() => namespace.apply(ctx));
  assert.equal(registrations.length, 2);
  // 降级不是「查了再兜底」，而是这一层压根不依赖它：服务缺席连问都不问。
  assert.equal(localeAsked, 0);
  const tree = reactStub().render(registrations[0].component, { view: 'page' });
  assert.match(visible(tree), /码农 DSH/);
});
