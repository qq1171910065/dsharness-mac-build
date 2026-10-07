/**
 * dsharness-update-ui — 应用内的「检查更新」入口（**浏览器半**）。
 *
 * ## 为什么它必须存在
 *
 * 官方壳已经把唯一的应用内更新 UI 暴露出来了：`dshDesktop.updates.open()`
 * （`apps/desktop/src/preload-app.ts:49-57` 暴露，`ipc.ts:82-86` 是契约，
 * `main.ts` 的 `openUpdatePrompt()` 弹原生对话框做检查 / 下载 / 安装）。
 * 但壳里**没有一个可点的入口**：`DesktopUpdateIndicator` 只在「有更新或出错」
 * 时渲染，idle 时 `return null`（`DesktopUpdateIndicator.tsx:64`）。
 * 于是「检查更新」这个动作在界面上无处可达。
 *
 * 上游文件一个字节都不能改（本 fork 的硬约束），所以入口只能由**插件**提供：
 * 设置 → 通用 的 `settings.general.item` 是一个上游公开的扩展位，
 * 一行就是一次 `slots.register`。
 *
 * ## 为什么是经典脚本，而不是 ESM
 *
 * 客户端 bundle 由 `document.createElement('script')` 加载
 * （`packages/client/modules/src/client/system.ts:16-29`），是**经典脚本**：
 * 它不能有 `import`/`export`，只能通过 `window.__ModuleLoader__.load` 注册
 * 自己的工厂；`factory(require)` 的返回值才是 Node 侧 Loader 认定的插件命名空间。
 * 所以宿主半（`update-ui.host.mjs`）必须是另一个文件 ——
 * 一个文件不可能同时是经典脚本和被 `import()` 挂载的 ESM 插件。
 *
 * ## 可 require 的东西只有基线
 *
 * `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` 是白名单。
 * 本文件只用 `react` 与 `react/jsx-runtime`：`dsh-client-locale` **不在**基线里，
 * require 它会当场抛错，所以文案是这里自带的中英字面量
 * （按 `navigator.language` 选，见 `chinese()`）—— 也正好满足
 * 「locale 服务缺席时整行照常渲染」。
 *
 * ## 不做的事
 *
 * 不下载、不安装、不自己判断版本：状态的唯一来源是 preload 的
 * `updates.status()` / `updates.subscribe()`，动作只有 `updates.open()`。
 * 没有 `dshDesktop`（纯浏览器 / web profile）时按钮禁用并说明原因，不抛错。
 *
 * `id` 必须逐字符等于包名 `dsharness-update-ui`，否则加载器按 `id` 对账不上、
 * 整个 bundle 被丢弃。
 */
window.__ModuleLoader__.load({
  id: 'dsharness-update-ui',
  factory: (require) => {
    const React = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');

    /** 双层文案：这一层的语言只由浏览器/文档的标签决定，不依赖任何服务。 */
    const COPY = {
      zh: {
        title: '检查更新',
        description: '打开桌面端的更新对话框，检查、下载并安装新版本。',
        action: '检查更新',
        opening: '正在打开…',
        idle: '尚未检查过更新。',
        checking: '正在检查更新…',
        available: '发现新版本 {version}，可在对话框中下载。',
        downloading: '正在下载 {percent}%。',
        verifying: '正在校验下载的安装包…',
        installing: '正在安装…',
        ready: '新版本 {version} 已就绪，重启后生效。',
        error: '更新失败：{reason}',
        reasonUnknown: '详情见桌面端对话框',
        unavailable: '仅在桌面端可用（当前是浏览器 / Web profile）。',
        openFailed: '打不开更新对话框。',
        failure: {
          check: '检查更新失败',
          'check-network': '网络不可达，检查更新失败',
          download: '下载失败',
          'download-network': '网络不可达，下载失败',
          install: '安装失败',
          'install-network': '网络不可达，安装失败',
          'stop-failed': '准备重启时停不掉正在运行的任务',
          'tasks-changed': '准备期间任务列表发生变化',
          'tasks-unavailable': '准备期间读不到任务状态',
        },
      },
      en: {
        title: 'Check for updates',
        description: 'Opens the Desktop update dialog to check, download, and install a new version.',
        action: 'Check for updates',
        opening: 'Opening…',
        idle: 'No update check has run yet.',
        checking: 'Checking for updates…',
        available: 'Version {version} is available; download it from the dialog.',
        downloading: 'Downloading {percent}%.',
        verifying: 'Verifying the downloaded installer…',
        installing: 'Installing…',
        ready: 'Version {version} is ready; it takes effect after a restart.',
        error: 'Update failed: {reason}',
        reasonUnknown: 'see the Desktop dialog for details',
        unavailable: 'Available in the Desktop app only (this is a browser / Web profile).',
        openFailed: 'The update dialog could not be opened.',
        failure: {
          check: 'the check failed',
          'check-network': 'the network is unreachable, so the check failed',
          download: 'the download failed',
          'download-network': 'the network is unreachable, so the download failed',
          install: 'the install failed',
          'install-network': 'the network is unreachable, so the install failed',
          'stop-failed': 'running tasks could not be stopped for the restart',
          'tasks-changed': 'the task list changed while preparing',
          'tasks-unavailable': 'task state was unreadable while preparing',
        },
      },
    };

    /** 桌面端正在忙的 phase：与 `DesktopUpdateSource.open()` 的守卫同一组。 */
    const BUSY = ['checking', 'downloading', 'verifying', 'installing'];

    const ROW = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '24px',
      padding: '16px 0',
      borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
    };
    const TITLE = { fontSize: '14px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' };
    const DESCRIPTION = { marginTop: '4px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' };
    const STATUS = { marginTop: '4px', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' };
    const BUTTON = {
      flex: 'none',
      padding: '6px 14px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
      cursor: 'pointer',
    };
    const BUTTON_DISABLED = { ...BUTTON, cursor: 'not-allowed', color: 'var(--dsw-alias-label-dimmed)' };

    /** 初始视图：没有 presentation、没有失败、没有正在打开。 */
    const INITIAL = { presentation: undefined, failed: false, opening: false };

    /**
     * 当前是否中文界面。
     *
     * 只读浏览器与文档自己声明的语言（`navigator.language`，退回
     * `<html lang>`），不碰 locale 服务：这个 bundle 不能 require 它，
     * 而 `ctx.get('locale')` 在纯浏览器组合里也可能为空。
     * @returns 中文界面为 true。
     */
    function chinese() {
      const tag = typeof navigator === 'object' && navigator !== null && typeof navigator.language === 'string' && navigator.language !== ''
        ? navigator.language
        : typeof document === 'object' && document !== null && document.documentElement !== null
          ? document.documentElement.lang
          : '';
      return typeof tag === 'string' && tag.toLowerCase().indexOf('zh') === 0;
    }

    /** 这一层的文案表。 */
    function copy() {
      return chinese() ? COPY.zh : COPY.en;
    }

    /**
     * 取 preload 的更新桥，或者 undefined。
     *
     * 桌面端在非拥有帧上只暴露 `{ protocolVersion: 1 }`（`preload-app.ts:100`），
     * 纯浏览器根本没有 `dshDesktop`，两种情况的答案都是「没有这一面」。
     * @returns `dshDesktop.updates`，或 undefined。
     */
    function bridge() {
      const carrier = globalThis.dshDesktop;
      const updates = carrier === null || typeof carrier !== 'object' ? undefined : carrier.updates;
      return updates === null || typeof updates !== 'object' || typeof updates.open !== 'function'
        ? undefined
        : updates;
    }

    /** 填 `{name}` 占位符（与 locale 服务的模板语法一致，不引入依赖）。 */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
    }

    /**
     * 把一个 presentation 说成人话。
     * @param view - 本组件的视图状态。
     * @param copy - 当前语言的文案表。
     * @returns 状态行文本。
     */
    function statusText(view, copy) {
      if (view.failed) return copy.openFailed;
      const presentation = view.presentation;
      if (presentation === null || typeof presentation !== 'object') return copy.idle;
      switch (presentation.phase) {
        case 'checking': return copy.checking;
        case 'available': return fill(copy.available, { version: presentation.version ?? '?' });
        case 'downloading': {
          const percent = typeof presentation.percent === 'number' ? Math.round(presentation.percent) : 0;
          return fill(copy.downloading, { percent });
        }
        case 'verifying': return copy.verifying;
        case 'installing': return copy.installing;
        case 'ready': return fill(copy.ready, { version: presentation.version ?? '?' });
        case 'error': return fill(copy.error, { reason: copy.failure[presentation.failure] ?? copy.reasonUnknown });
        default: return copy.idle;
      }
    }

    /**
     * 通用设置里的一行：说明 + 一个按钮。
     *
     * owner props 是空的（`settings.general.item` 的 owner 只有
     * `children?: never`），所以这一行自己画完自己的全部内容；
     * 订阅与初始状态都走 effect，卸载时释放 disposer。
     * @returns 这一行的元素树。
     */
    function UpdateRow() {
      const [view, setView] = React.useState(INITIAL);
      const alive = React.useRef(true);
      React.useEffect(() => {
        alive.current = true;
        const updates = bridge();
        if (updates === undefined) return undefined;
        let received = false;
        let unsubscribe;
        if (typeof updates.subscribe === 'function') {
          const result = updates.subscribe((presentation) => {
            if (!alive.current) return;
            received = true;
            setView((previous) => ({ ...previous, presentation, failed: false }));
          });
          if (typeof result === 'function') unsubscribe = result;
        }
        if (typeof updates.status === 'function') {
          Promise.resolve().then(() => updates.status()).then(
            (presentation) => {
              if (alive.current && !received) setView((previous) => ({ ...previous, presentation }));
            },
            () => {
              if (alive.current && !received) setView((previous) => ({ ...previous, failed: true }));
            },
          );
        }
        return () => {
          alive.current = false;
          if (unsubscribe !== undefined) unsubscribe();
        };
      }, []);
      const current = copy();
      const updates = bridge();
      const presentation = view.presentation;
      const busy = view.opening
        || (presentation !== null && typeof presentation === 'object' && BUSY.indexOf(presentation.phase) >= 0);
      const disabled = updates === undefined || busy;
      const open = () => {
        const live = bridge();
        if (live === undefined || !alive.current) return;
        setView((previous) => ({ ...previous, opening: true, failed: false }));
        Promise.resolve().then(() => live.open()).then(
          () => { if (alive.current) setView((previous) => ({ ...previous, opening: false })); },
          () => { if (alive.current) setView((previous) => ({ ...previous, opening: false, failed: true })); },
        );
      };
      return jsxs('div', {
        style: ROW,
        children: [
          jsxs('div', {
            children: [
              jsx('div', { style: TITLE, children: current.title }),
              jsx('div', { style: DESCRIPTION, children: current.description }),
              jsx('div', {
                style: STATUS,
                role: 'status',
                children: updates === undefined ? current.unavailable : statusText(view, current),
              }),
            ],
          }),
          jsx('button', {
            type: 'button',
            style: disabled ? BUTTON_DISABLED : BUTTON,
            disabled,
            onClick: open,
            children: view.opening ? current.opening : current.action,
          }),
        ],
      });
    }

    /**
     * 注册这一行。
     *
     * `order: 90` 夹在 `developer-tools`(15) 与 `current-version`(100) 之间
     * （`ui-settings-general/src/client/index.ts:76-87`）。
     * 用 `slots.inject` 而不是裸 `register`：`settings.general.item` 的声明
     * 来自另一个包，apply 顺序无约束，inject 会在声明就位后注册、
     * 声明消失时自动撤回。
     * @param ctx - 客户端根上下文（`slots` 由 inject 声明保证就绪）。
     */
    function apply(ctx) {
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'dsharness-update',
        order: 90,
        label: () => copy().action,
      }, UpdateRow));
    }

    /** 只依赖 slots 服务。 */
    const inject = ['slots'];

    return { apply, inject };
  },
});
