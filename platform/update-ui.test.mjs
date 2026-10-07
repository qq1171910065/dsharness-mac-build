import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { PROFILE_PLUGINS } from './provision.mjs';

/**
 * `dsharness-update-ui` 的浏览器半。
 *
 * 这一层最容易悄悄错的三件事，都在下面**真求值**验，而不是拿源码做字符串比对：
 *
 * 1. 注册 `id` 必须等于包名 —— 加载器按 `id` 对账，不一致时整个 bundle 被丢弃
 *    （`packages/client/modules/src/client/system.ts:164-178` 的 register 只认 id）；
 * 2. bundle 是**经典脚本**：它由 `document.createElement('script')` 执行，
 *    所以只能通过 `window.__ModuleLoader__.load({ id, factory })` 注册自己的工厂，
 *    不能有 `import`/`export`。这里在 vm 里当脚本跑一遍就是证明；
 * 3. 没有 `dshDesktop` 时（浏览器 / Web profile）必须渲染「仅在桌面端可用」
 *    且按钮禁用，**不能抛错** —— 这是最可能让整行消失的路径。
 *
 * `factory(require)` 只允许要基线模块（`packages/client/web/src/platform.ts`
 * 的 `PLATFORM_MODULES`）。`dsh-client-locale` **不在**里面，所以 require 白名单
 * 也被钉住：想接 locale 服务必须先把清单改了，不会静默失败。
 */

/** 这个插件在 `PROFILE_PLUGINS` 里的那一条。 */
const PLUGIN = PROFILE_PLUGINS.find((entry) => entry.name === 'dsharness-update-ui');

const here = import.meta.dirname;
const clientDir = join(here, '..');
const bundle = readFileSync(join(here, PLUGIN.clientEntry), 'utf8');

/** 允许被 require 的基线（本 bundle 只该用前两个）。 */
const BASELINE = new Set(['react', 'react/jsx-runtime']);

/**
 * 一个够用的 `react` 桩。
 *
 * `useState`/`useRef` 按固定顺序的槽位存值（React 的 hook 纪律），
 * `useEffect` 只登记不自动跑 —— 由测试显式触发，才能区分「渲染」与「已挂载」。
 * `jsx`/`jsxs` 产出可遍历的对象树。
 * @returns 桩 API 与它的槽位。
 */
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
    /** 按固定 hook 顺序渲染一次。 */
    render(Component) {
      cursor = 0;
      return Component({});
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

/**
 * 在假 `window.__ModuleLoader__` 上把 bundle 当**经典脚本**真跑一遍。
 * @param globals - 写进 vm 全局的东西（`dshDesktop` / `navigator`）。
 * @returns 记下来的注册、require 过的模块、react 桩与插件命名空间。
 */
function evaluate(globals = {}) {
  const registrations = [];
  const sandbox = {
    navigator: globals.navigator ?? { language: 'zh-CN' },
    document: globals.document,
    dshDesktop: globals.dshDesktop,
    window: {
      __ModuleLoader__: {
        load(registration) { registrations.push(registration); },
      },
    },
  };
  const context = createContext(sandbox);
  runInContext(bundle, context, { filename: PLUGIN.clientEntry });
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
  return { registration, namespace, required, react };
}

/** 记录 `slots.register` 参数的桩上下文。 */
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

/** 在对象树里找第一个该类型的节点。 */
function find(node, type) {
  if (node === null || typeof node !== 'object') return undefined;
  if (node.type === type) return node;
  const children = node.props === undefined ? undefined : node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = find(child, type);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 对象树里所有字符串拼起来，便于断言「用户能看到这句话」。 */
function visible(node) {
  if (typeof node === 'string') return node;
  if (node === null || typeof node !== 'object') return '';
  const children = node.props === undefined ? undefined : node.props.children;
  if (children === undefined || children === null) return '';
  return (Array.isArray(children) ? children : [children]).map(visible).join(' ');
}

/** 按 `role` 找节点（状态行的断言比「第一个 div」精确）。 */
function findRole(node, role) {
  if (node === null || typeof node !== 'object') return undefined;
  if (node.props?.role === role) return node;
  const children = node.props === undefined ? undefined : node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const hit = findRole(child, role);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

test('bundle：用假 window 真求值，注册 id 等于包名，且只 require 基线模块', () => {
  const { registration, namespace, required } = evaluate();
  // `id` 必须逐字符等于包名：加载器按它对账，不一致时整个 bundle 被丢弃。
  assert.equal(registration.id, PLUGIN.name);
  assert.equal(registration.id, 'dsharness-update-ui');
  assert.deepEqual([...new Set(required)].sort(), ['react', 'react/jsx-runtime']);
  // Loader 的插件面：有 apply 与 inject 才不会被当成无效插件。
  assert.equal(typeof namespace.apply, 'function');
  // vm 里造出来的数组有另一个 realm 的 Array 原型，所以逐元素比。
  assert.equal(namespace.inject.length, 1);
  assert.equal(namespace.inject[0], 'slots');
});

test('apply：注册到 settings.general.item，order 90，id dsharness-update', () => {
  const { namespace } = evaluate();
  const { ctx, registrations, injections } = slotContext();
  // 不抛：`ctx.get('locale')` 这条路径在本 bundle 里根本不存在（见下一条断言）。
  namespace.apply(ctx);
  assert.deepEqual(injections, ['settings.general.item']);
  assert.equal(registrations.length, 1);
  const { options, component } = registrations[0];
  assert.equal(options.name, 'settings.general.item');
  assert.equal(options.id, 'dsharness-update');
  // 夹在 developer-tools(15) 与 current-version(100) 之间。
  assert.equal(options.order, 90);
  // 不声明 locale: 这个 bundle 不能 require locale 服务，声明了框架会去找一个
  // 没人注册过的命名空间。
  assert.equal('locale' in options, false);
  assert.equal(typeof component, 'function');
  // 标签是 thunk（框架每次读取时求值），不是一次性字符串。
  assert.equal(typeof options.label, 'function');
  assert.equal(typeof options.label(), 'string');
});

test('apply：ctx 上完全没有 locale 服务也不抛，照样注册这一行', () => {
  const { namespace } = evaluate();
  const registrations = [];
  let localeAsked = 0;
  const ctx = {
    // 一个只有 slots 的上下文：`get` 存在但返回 undefined，`locale` 不存在。
    get() { localeAsked += 1; return undefined; },
    slots: {
      inject(name, callback) { return callback(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
  };
  assert.doesNotThrow(() => namespace.apply(ctx));
  assert.equal(registrations.length, 1);
  // 降级不是「查了再兜底」，而是这一层压根不依赖它：服务缺席连问都不问。
  assert.equal(localeAsked, 0);
});

test('浏览器 / Web profile：没有 dshDesktop 时渲染说明并禁用按钮', () => {
  const { namespace, react } = evaluate();
  const { ctx, registrations } = slotContext();
  namespace.apply(ctx);
  const tree = react.render(registrations[0].component);
  const button = find(tree, 'button');
  assert.ok(button !== undefined);
  assert.equal(button.props.disabled, true);
  // 说明文字必须出现，且是可读的整句。
  assert.match(visible(tree), /仅在桌面端可用/);
  // 状态行也说明原因，而不是留空。
  assert.match(visible(findRole(tree, 'status')), /仅在桌面端可用/);
  // 没有桥时点击不做任何事，也不抛。
  assert.doesNotThrow(() => button.props.onClick());
});

test('桌面端：订阅 + 初始状态，phase 说成人话，卸载时释放 disposer', async () => {
  const listeners = [];
  const disposers = [];
  const opened = [];
  const dshDesktop = {
    protocolVersion: 1,
    updates: {
      open: () => { opened.push(true); return Promise.resolve(); },
      status: () => Promise.resolve({ phase: 'idle' }),
      subscribe(listener) {
        listeners.push(listener);
        return () => { disposers.push(true); };
      },
    },
  };
  const { namespace, react } = evaluate({ dshDesktop, navigator: { language: 'en-US' } });
  const { ctx, registrations } = slotContext();
  namespace.apply(ctx);
  const component = registrations[0].component;

  const tree = react.render(component);
  const button = find(tree, 'button');
  assert.equal(button.props.disabled, false, 'idle is not a busy phase');
  // 英文界面走内置英文文案（不依赖 locale 服务）。
  assert.match(visible(tree), /Check for updates/);

  // effect 未跑之前一件事都没发生：订阅与初始状态都在 effect 里。
  assert.equal(react.effects.length, 1);
  assert.equal(listeners.length, 0);
  const cleanup = react.effects[0]();
  assert.equal(listeners.length, 1);

  // 订阅回调把 phase 渲染成人话。
  listeners[0]({ phase: 'downloading', version: '1.0.0', percent: 42.4 });
  assert.match(visible(react.render(component)), /Downloading 42%/);
  listeners[0]({ phase: 'error', failure: 'download-network' });
  assert.match(visible(react.render(component)), /network is unreachable/);
  listeners[0]({ phase: 'ready', version: '9.9.9' });
  assert.match(visible(react.render(component)), /9\.9\.9/);
  listeners[0]({ phase: 'installing' });
  assert.equal(find(react.render(component), 'button').props.disabled, true, 'a busy phase disables the button');

  // 卸载：disposer 必须被调用（否则每次设置面板开关都漏一个 IPC 监听）。
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.deepEqual(disposers, [true]);
  // 卸载后到来的推送不再写状态。
  const writes = react.setters.length;
  assert.doesNotThrow(() => listeners[0]({ phase: 'available', version: '2.0.0' }));
  assert.equal(react.setters.length, writes);

  // 点击调用官方桥的 open()（卸载后按钮仍在文档里时也不例外：桥自己仍是活的，
  // 只是这一行不再被渲染）。
  const mounted = evaluate({ dshDesktop, navigator: { language: 'en-US' } });
  const mountedCtx = slotContext();
  mounted.namespace.apply(mountedCtx.ctx);
  const mountedComponent = mountedCtx.registrations[0].component;
  mounted.react.render(mountedComponent);
  const liveCleanup = mounted.react.effects[0]();
  find(mounted.react.render(mountedComponent), 'button').props.onClick();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(opened, [true]);
  assert.deepEqual(disposers.length, 1);
  liveCleanup();
  assert.deepEqual(disposers.length, 2);
});

test('中文界面由 navigator.language 决定，而不是任何服务', () => {
  const zh = evaluate({ navigator: { language: 'zh-CN' }, dshDesktop: undefined });
  const zhCtx = slotContext();
  zh.namespace.apply(zhCtx.ctx);
  assert.equal(zhCtx.registrations[0].options.label(), '检查更新');
  // 有桥时状态行才说「尚未检查过更新」；没有桥时说的是「仅桌面端可用」。
  assert.match(visible(zh.react.render(zhCtx.registrations[0].component)), /仅在桌面端可用/);
  const withBridge = evaluate({
    navigator: { language: 'zh-CN' },
    dshDesktop: { protocolVersion: 1, updates: { status: () => Promise.resolve({ phase: 'idle' }), subscribe: () => () => {}, open: () => Promise.resolve() } },
  });
  const withBridgeCtx = slotContext();
  withBridge.namespace.apply(withBridgeCtx.ctx);
  assert.match(visible(withBridge.react.render(withBridgeCtx.registrations[0].component)), /尚未检查过更新/);

  const en = evaluate({ navigator: { language: 'fr-FR' } });
  const enCtx = slotContext();
  en.namespace.apply(enCtx.ctx);
  assert.equal(enCtx.registrations[0].options.label(), 'Check for updates');

  // 没有 navigator 时退回 `<html lang>`，两者都没有时用英文（不该抛）。
  const fallback = evaluate({ navigator: {}, document: { documentElement: { lang: 'zh-Hans' } } });
  const fallbackCtx = slotContext();
  fallback.namespace.apply(fallbackCtx.ctx);
  assert.equal(fallbackCtx.registrations[0].options.label(), '检查更新');
});

test('包声明与宿主半：客户端半不能同时是 Loader 的入口', () => {
  // 两者是不同的文件：`index.mjs`（宿主半）被 Node import，`client.js`
  // 是经典脚本；一个文件做不到两件事。
  assert.notEqual(PLUGIN.entry, PLUGIN.clientEntry);
  const host = readFileSync(join(here, PLUGIN.entry), 'utf8');
  // 宿主半不负责浏览器那一半：没有 window，也没有 __ModuleLoader__。
  assert.ok(!host.includes('__ModuleLoader__'));
  assert.ok(!host.includes('window.'));
  // 浏览器半确实是通过加载器门面注册的，而不是 ESM 命名空间。
  assert.ok(bundle.includes('window.__ModuleLoader__.load('));
  assert.ok(!/^\s*(?:import|export)\s/m.test(bundle), 'a classic script cannot use import/export');
});

test('包扫描规则：生成的 package.json 满足上游激活扫描的两条硬条件', () => {
  /*
   * roster 只认 `dsh.client.platform === 'web'`（`parseDshClient`，拼错会被
   * 静默忽略）与能解析出真实文件的 `exports['./client']`
   * （`packages/client/modules/src/index.ts:823-848`）。这两条由真实产物断言，
   * 而不是靠源码里的字符串。
   */
  assert.equal(PLUGIN.clientEntry, 'update-ui.js');
  assert.equal(PLUGIN.name, 'dsharness-update-ui');
  // 上游那两条判据原文仍在（改上游形状时这里会红，而不是悄悄不加载）。
  const scan = readFileSync(join(clientDir, 'packages', 'client', 'modules', 'src', 'index.ts'), 'utf8');
  assert.match(scan, /decl === undefined \|\| decl\.platform !== 'web'/u);
  assert.match(scan, /exports\["\.\/client"\]/u);
  // 客户端半的第一条语句就是加载器门面（允许前面有文档注释），且文件里没有 import/export。
  assert.match(bundle, /^window\.__ModuleLoader__\.load\(\{$/mu);
});
