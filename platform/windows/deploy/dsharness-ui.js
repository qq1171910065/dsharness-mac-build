/**
 * dsharness-ui — 合并后的 `dsharness` 组合包的**浏览器半**。
 *
 * ## 它是什么
 *
 * 产品把原来四个各自独立的插件（本机网关 / 模型 Key / 检查更新 / Host 检查更新）
 * 合并成一个组合包 `dsharness`：Loader 里只有一行、插件页里只有一张卡片，
 * 卡片**不能关闭、也不能卸载**（宿主半用 `management-required` 保护）。
 * 于是「这些组件在干什么」必须有个地方看得见：这个文件就是那个只读面板。
 *
 * 面板是**纯展示**的：四个组件各一行，一个状态词加一两条事实。
 * 没有输入框、没有开关、没有可写的配置 —— 组件本身就没有单独开关。
 * 用户的原话：「插件的组件中只是显示组件状态，而不需要显示key的信息」
 * 「登录之后就能同步到用户的key，并且获取费用等信息」「要显示当前dsh运行的端口等等」。
 *
 * ## 两处注册，一套实现
 *
 * `apply(ctx)` 用**同一份状态源**与**同一张文案表**注册两个面：
 *
 * 1. `plugins.bundle.config`（key = 包名 `dsharness`）—— 插件页里那张卡片自己的
 *    配置区。契约在 `ui-plugin-manager/src/client/slot-contract.ts:102`
 *    （`kind: 'keyed'`，owner 是 `PluginConfigViewProps = { view, form? }`），
 *    渲染点在 `PluginManagerPage.tsx:680`：
 *    `renderSlot('plugins.bundle.config', { view: 'page' }, { entryKey: pkg.name })`，
 *    外面套着 `configured={ledger.bundles.has(openPkg.name)}`（`:1497`）——
 *    而 `ledger.bundles` 正是 `options.key` 的集合（`config-ledger.ts:52/66`），
 *    所以 `key` 必须逐字符等于包名 `dsharness`，否则这一页根本不渲染。
 *    页面**无条件**用 `view: 'page'` 渲染，不依赖任何 settings `form`：
 *    面板不能假设存在可写表单。
 * 2. `settings.general.item`（`id: 'dsharness'`，`order: 90`）—— 「设置 › 通用」
 *    里那一行「检查更新」。声明在 `ui-settings-general/src/client/index.ts:76/84`
 *    （`developer-tools` 是 15，`current-version` 是 100，90 夹在中间），
 *    槽类型在 `ui-settings/src/client/contract/slots.ts:92`（list、owner 为空）。
 *    它注册的是**同一个更新组件**，不再是第二个插件 —— 这正是用户要的
 *    「检查更新和应用内检查更新不再是两件事」。这一行也必须经
 *    `slots.inject` 注册：声明来自另一个包，apply 顺序无约束。
 *
 * ## 为什么是经典脚本，而不是 ESM
 *
 * 客户端 bundle 由 `document.createElement('script')` 加载
 * （`packages/client/modules/src/client/system.ts:16-29`），是**经典脚本**：
 * 不能有 `import`/`export`，只能通过 `window.__ModuleLoader__.load` 注册工厂。
 * 所以宿主半是另一个文件（`dsharness.mjs`），浏览器半就是这个文件。
 *
 * `id` 必须逐字符等于包名 `dsharness`，否则加载器按 `id` 对账不上、整个 bundle 被丢弃。
 *
 * ## 可 require 的东西只有基线
 *
 * `packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES` 是白名单。
 * 本文件只用 `react` 与 `react/jsx-runtime`：`@deepseek-ai/dsh-client-locale`
 * **不在**基线里，require 它会当场抛错，所以文案是这里自带的中英字面量
 * （按 `navigator.language` 选，见 `chinese()`）。也因此注册里**不声明 `locale`**：
 * 声明 `locale` 会让框架去要一个没人注册过的命名空间并 fail loud，
 * 而这一层面板本来就不需要 `t` 席位。
 *
 * ## 状态只有一个来源：`GET /dsharness/status.json`
 *
 * 相对页面 origin 取（`location.origin + '/dsharness/status.json'`），
 * 挂载时取一次、之后每 10s 轮询一次，卸载时停掉。字段是宿主半钉死的契约；
 * 这里**只读布尔与展示性字段**，永远不读也不画任何密钥/Key 值：
 * `tokenConfigured`（布尔）、`modelKey.configured`（布尔）、`port`、`address`、
 * `version`、`account`。拿不到、403、超时、JSON 不是对象 —— 一律降级成
 * 「状态暂时读不到」，其余部分照常渲染，绝不抛错。
 *
 * ## 值只有一个来源，而且只在点击时读：`GET /dsharness/secret.json`
 *
 * 「本机网关」与「模型 Key」两行右侧各有一个复制按钮（用户口径：「本机网关一行
 * 右侧要有复制密钥的按钮，点击之后复制共享密钥」「模型 key 也是，要有复制 key
 * 的按钮」）。值走**另一个面**、在**点击那一刻**取：状态面每 10s 轮询一次，
 * 把值并进它就等于让它每 10s 过一次网络。取到的值只经过点击处理器一路到
 * `navigator.clipboard.writeText`，不进 React 状态、不进 props、不进渲染树 ——
 * 能画出来的只有结果（空闲 / 已复制 / 复制失败，2s 后自己消失）。
 *
 * 风格只允许 `--dsw-*` CSS 自定义属性（沿用 `update-ui.js` 的写法），
 * 颜色写在内联 style 对象里：经典脚本不能 import CSS。
 */
window.__ModuleLoader__.load({
  id: 'dsharness',
  factory: (require) => {
    const React = require('react');
    const { jsx, jsxs } = require('react/jsx-runtime');

    /** 只读状态面的路径；宿主半在 loopback 上回答，非 loopback 是 403。 */
    const STATUS_PATH = '/dsharness/status.json';

    /**
     * 按需取值面的路径；与状态面**分开**，值只在用户点「复制」那一刻读。
     *
     * 为什么不复用状态面：那一面每 10s 被轮询一次，而凭据值是「按需读一次」
     * 的语义。分成两个面，「值只在点击时离开进程」就落在一条可断言的路径上。
     */
    const SECRET_PATH = '/dsharness/secret.json';

    /** 轮询间隔（挂载期间）。10s 足够，且面板是给人看的，不是实时仪表。 */
    const POLL_MS = 10000;

    /** 「已复制 / 复制失败」显示多久。短暂确认，不是常驻状态。 */
    const CONFIRM_MS = 2000;

    /** 宿主半钉死的凭据引用名（`/dsharness/status.json` 的 `modelKey.ref`）。 */
    const MODEL_KEY_REF = 'DSHARNESS_MODEL_KEY';

    /** 双层文案：这一层的语言只由浏览器/文档的标签决定，不依赖任何服务。 */
    const COPY = {
      zh: {
        action: '检查更新',
        panel: {
          title: '码农 DSH',
          note: '本产品自带的插件：四个组件常驻，不能单独关闭。',
          summary: '本机网关 / 模型 Key / 检查更新 / 账号与费用',
          unavailable: '状态暂时读不到',
          copy: '复制',
          copied: '已复制',
          copyFailed: '复制失败',
        },
        component: {
          gateway: '本机网关',
          modelKey: '模型 Key',
          update: '检查更新',
          account: '账号与费用',
        },
        state: {
          running: '运行中',
          disabled: '未启用',
          unknown: '未知',
          synced: '已同步',
          unsynced: '未同步',
          signedIn: '已登录',
          signedOut: '未登录',
          latest: '已是最新',
          available: '有新版本 {version}',
          unchecked: '尚未检查',
          checkFailed: '查询失败',
        },
        fact: {
          port: '监听端口 {port}',
          address: '本机地址 {address}',
          sharedSecret: '共享密钥',
          configured: '已配置',
          unconfigured: '未配置',
          credential: '凭据名',
          currentVersion: '当前版本 {version}',
          latestVersion: '最新版本 {version}',
          none: '—',
          balance: '余额',
        },
        update: {
          title: '检查更新',
          description: '打开桌面端的更新对话框，检查、下载并安装新版本。',
          action: '检查更新',
          opening: '正在打开…',
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
      },
      en: {
        action: 'Check for updates',
        panel: {
          title: '码农 DSH',
          note: 'This is the product\u2019s own plugin: all four components stay on and cannot be switched off individually.',
          summary: 'Local gateway / Model key / Update check / Account & billing',
          unavailable: 'Status is unavailable right now',
          copy: 'Copy',
          copied: 'Copied',
          copyFailed: 'Copy failed',
        },
        component: {
          gateway: 'Local gateway',
          modelKey: 'Model key',
          update: 'Check for updates',
          account: 'Account & billing',
        },
        state: {
          running: 'Running',
          disabled: 'Off',
          unknown: 'Unknown',
          synced: 'Synced',
          unsynced: 'Not synced',
          signedIn: 'Signed in',
          signedOut: 'Signed out',
          latest: 'Up to date',
          available: 'Version {version} available',
          unchecked: 'Not checked yet',
          checkFailed: 'Check failed',
        },
        fact: {
          port: 'Listening port {port}',
          address: 'Local address {address}',
          sharedSecret: 'Shared secret',
          configured: 'configured',
          unconfigured: 'not configured',
          credential: 'Credential',
          currentVersion: 'Current version {version}',
          latestVersion: 'Latest version {version}',
          none: '\u2014',
          balance: 'Balance',
        },
        update: {
          title: 'Check for updates',
          description: 'Opens the Desktop update dialog to check, download, and install a new version.',
          action: 'Check for updates',
          opening: 'Opening\u2026',
          checking: 'Checking for updates\u2026',
          available: 'Version {version} is available; download it from the dialog.',
          downloading: 'Downloading {percent}%.',
          verifying: 'Verifying the downloaded installer\u2026',
          installing: 'Installing\u2026',
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

    const PANEL = { display: 'flex', flexDirection: 'column' };
    const PANEL_HEAD = { paddingBottom: '12px' };
    const PANEL_TITLE = { fontSize: '14px', lineHeight: '20px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)' };
    const PANEL_NOTE = { marginTop: '4px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px' };
    const NOTICE = { margin: '0 0 4px', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' };
    /** 复制按钮旁边那次短暂确认：贴着按钮，不换行，避免行高一跳。 */
    const COPY_RESULT = {
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '12px',
      lineHeight: '18px',
      whiteSpace: 'nowrap',
    };
    /** 行尾控件容器：复制按钮要跟确认并排。 */
    const COMPONENT_TRAILING = { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' };
    const COMPONENT_ROW = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '10px 0',
      borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
    };
    const COMPONENT_MAIN = { minWidth: '0' };
    const COMPONENT_HEAD = { display: 'flex', alignItems: 'center', gap: '8px' };
    const COMPONENT_NAME = { fontSize: '13px', lineHeight: '18px', color: 'var(--dsw-alias-label-primary)' };
    const COMPONENT_STATE = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' };
    const FACTS = {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '2px 12px',
      marginTop: '2px',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: '12px',
      lineHeight: '18px',
    };

    /** 状态点的颜色：只用 token，且只分四档语义。 */
    const TONE = {
      ok: 'var(--dsw-static-green-500)',
      info: 'var(--dsw-static-blue-500)',
      warn: 'var(--dsw-static-red-500)',
      idle: 'var(--dsw-alias-label-dimmed)',
    };

    /** 初始视图：没有 presentation、没有失败、没有正在打开。 */
    const INITIAL = { presentation: undefined, failed: false, opening: false };

    /** 复制按钮的初始结果：点之前什么都不说。 */
    const COPY_IDLE = 'idle';

    /** 还没有读到状态时的视图。 */
    const READING = { phase: 'reading', data: null };

    /**
     * 当前是否中文界面。
     *
     * 只读浏览器与文档自己声明的语言（`navigator.language`，退回
     * `<html lang>`），不碰 locale 服务：这个 bundle 不能 require 它。
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

    /** 填 `{name}` 占位符（与 locale 服务的模板语法一致，不引入依赖）。 */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
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

    /** 这一层是否能在界面上看到状态面。 */
    function statusUrl() {
      const origin = typeof location === 'object' && location !== null && typeof location.origin === 'string'
        ? location.origin
        : '';
      return `${origin}${STATUS_PATH}`;
    }

    /**
     * 按需取值面的地址 —— 与状态面同一个写法：相对页面 origin，不硬编码 host。
     * @returns 取值面的绝对 URL。
     */
    function secretUrl() {
      const origin = typeof location === 'object' && location !== null && typeof location.origin === 'string'
        ? location.origin
        : '';
      return `${origin}${SECRET_PATH}`;
    }

    /**
     * 从按需取值面读一条凭据值。
     *
     * 只有把值交给剪贴板这一条路需要它，所以返回的就是那一个字符串：
     * 网络错误、非 2xx、响应不是对象、挑不出非空字符串 —— 统一是 `undefined`，
     * 由调用方折成「复制失败」。**不抛**：一次点击不该把面板打崩。
     *
     * @param pick - 从响应体里挑出这个组件那一条值的函数。
     * @returns 值，或 undefined。
     */
    function readSecret(pick) {
      const request = globalThis.fetch;
      if (typeof request !== 'function') return Promise.resolve(undefined);
      return Promise.resolve()
        .then(() => request(secretUrl()))
        .then((response) => (isRecord(response) && response.ok === true ? response.json() : undefined))
        .then((data) => (isRecord(data) ? pick(data) : undefined))
        .then(
          (text) => (typeof text === 'string' && text !== '' ? text : undefined),
          () => undefined,
        );
    }

    /**
     * 把值写进系统剪贴板。
     *
     * `navigator.clipboard` 在非安全上下文（http 且非回环）里不存在，那是**正常
     * 环境**而不是异常，所以这里返回 `false` 让调用方说「复制失败」，而不是抛。
     * @param secret - 要复制的值。
     * @returns 是否真的写进去了。
     */
    function writeClipboard(secret) {
      const clipboard = typeof navigator === 'object' && navigator !== null ? navigator.clipboard : undefined;
      if (clipboard === null || typeof clipboard !== 'object' || typeof clipboard.writeText !== 'function') {
        return Promise.resolve(false);
      }
      return Promise.resolve().then(() => clipboard.writeText(secret)).then(() => true, () => false);
    }

    /**
     * 取值面响应里「本机网关」那一条：网关段的 token 字段。
     * @param data - 取值面的响应体。
     * @returns 值，或 undefined（响应形状不认识）。
     */
    function gatewaySecret(data) {
      const gateway = isRecord(data.gateway) ? data.gateway : undefined;
      if (gateway === undefined) return undefined;
      return gateway.token;
    }

    /**
     * 取值面响应里「模型 Key」那一条：模型 Key 段的明文。
     *
     * 这是这一层**唯一**读凭据值的地方，调用点只有复制按钮的点击处理器。
     * @param data - 取值面的响应体。
     * @returns 值，或 undefined。
     */
    function modelKeySecret(data) {
      const entry = isRecord(data.modelKey) ? data.modelKey : undefined;
      if (entry === undefined) return undefined;
      return entry.value;
    }

    /** 一个不是对象的响应体，等于没有状态。 */
    function isRecord(candidate) {
      return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate);
    }

    /**
     * 每 10s 读一次只读状态面；挂载时立即读一次，卸载时停表。
     *
     * 任何失败都降级成 `{ phase: 'error' }`：非 2xx、网络错误、`fetch` 缺席、
     * 响应体不是对象。绝不抛错、绝不清空已经渲染好的东西。
     * @returns `{ phase, data }`，`phase` 是 `reading` / `ready` / `error`。
     */
    function useStatus() {
      const [view, setView] = React.useState(READING);
      const alive = React.useRef(true);
      React.useEffect(() => {
        alive.current = true;
        let inFlight = false;
        const load = () => {
          if (inFlight) return;
          const request = globalThis.fetch;
          if (typeof request !== 'function') {
            setView({ phase: 'error', data: null });
            return;
          }
          inFlight = true;
          Promise.resolve().then(() => request(statusUrl())).then(
            (response) => {
              if (response === null || typeof response !== 'object' || response.ok !== true) {
                throw new Error('status unavailable');
              }
              return response.json();
            },
          ).then(
            (data) => {
              inFlight = false;
              if (!alive.current) return;
              setView(isRecord(data) ? { phase: 'ready', data } : { phase: 'error', data: null });
            },
            () => {
              inFlight = false;
              if (alive.current) setView({ phase: 'error', data: null });
            },
          );
        };
        load();
        const every = globalThis.setInterval;
        const stop = globalThis.clearInterval;
        const timer = typeof every === 'function' ? every(load, POLL_MS) : undefined;
        return () => {
          alive.current = false;
          if (timer !== undefined && typeof stop === 'function') stop(timer);
        };
      }, []);
      return view;
    }

    /**
     * 订阅 preload 的更新 phase，并给出打开对话框的动作。
     *
     * owner props 是空的，所以这一层自己管订阅与初始状态；卸载时释放 disposer。
     * @returns `{ view, open }`：视图状态与打开动作。
     */
    function useUpdateView() {
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
      const open = () => {
        const live = bridge();
        if (live === undefined || !alive.current) return;
        setView((previous) => ({ ...previous, opening: true, failed: false }));
        Promise.resolve().then(() => live.open()).then(
          () => { if (alive.current) setView((previous) => ({ ...previous, opening: false })); },
          () => { if (alive.current) setView((previous) => ({ ...previous, opening: false, failed: true })); },
        );
      };
      return { view, open };
    }

    /**
     * 一个组件的「复制」状态：空闲 / 已复制 / 复制失败。
     *
     * ⚠️ **值不在这里**。点击处理器自己走 fetch → 剪贴板，hooks 只保留结果
     * （`idle` / `copied` / `failed`），所以密钥与模型 Key 的值从来进不了
     * React 状态，也就没有任何渲染路径能把它画出来。确认是短暂的：2s 后回 idle。
     *
     * `disable` 为真时按钮禁用 —— 那表示宿主半已经说了「这一项没有值」
     * （`tokenConfigured` / `configured` 不为真），点它只会有一次注定失败的请求。
     * @param pick - 从取值面响应里挑出这个组件那一条值的函数。
     * @param disable - 值是否已知缺席（按钮禁用）。
     * @returns `{ outcome, disabled, copy }`：结果、禁用态与点击动作。
     */
    function useCopy(pick, disable) {
      const [outcome, setOutcome] = React.useState(COPY_IDLE);
      const alive = React.useRef(true);
      const timer = React.useRef(undefined);
      React.useEffect(() => () => {
        alive.current = false;
        if (timer.current !== undefined && typeof globalThis.clearTimeout === 'function') {
          globalThis.clearTimeout(timer.current);
        }
      }, []);
      const copy = () => {
        if (disable) return;
        const settle = (next) => {
          if (!alive.current) return;
          setOutcome(next);
          if (timer.current !== undefined && typeof globalThis.clearTimeout === 'function') {
            globalThis.clearTimeout(timer.current);
          }
          if (typeof globalThis.setTimeout === 'function') {
            timer.current = globalThis.setTimeout(() => {
              timer.current = undefined;
              if (alive.current) setOutcome(COPY_IDLE);
            }, CONFIRM_MS);
          }
        };
        Promise.resolve()
          .then(() => readSecret(pick))
          .then((secret) => (secret === undefined ? false : writeClipboard(secret)))
          .then(
            (done) => settle(done ? 'copied' : 'failed'),
            () => settle('failed'),
          );
      };
      return { outcome, disabled: disable === true, copy };
    }

    /** 桌面端是否正在忙（正在打开，或处于四个忙 phase 之一）。 */
    function busy(view) {
      const presentation = view.presentation;
      return view.opening
        || (presentation !== null && typeof presentation === 'object' && BUSY.indexOf(presentation.phase) >= 0);
    }

    /**
     * 把一个 presentation 说成人话。
     * @param presentation - preload 报告的更新状态。
     * @param current - 当前语言的文案表。
     * @returns 状态行文本。
     */
    function updatePhaseText(presentation, current) {
      switch (presentation.phase) {
        case 'checking': return current.update.checking;
        case 'available': return fill(current.update.available, { version: presentation.version ?? '?' });
        case 'downloading': {
          const percent = typeof presentation.percent === 'number' ? Math.round(presentation.percent) : 0;
          return fill(current.update.downloading, { percent });
        }
        case 'verifying': return current.update.verifying;
        case 'installing': return current.update.installing;
        case 'ready': return fill(current.update.ready, { version: presentation.version ?? '?' });
        case 'error': return fill(current.update.error, { reason: current.update.failure[presentation.failure] ?? current.update.reasonUnknown });
        default: return undefined;
      }
    }

    /**
     * 更新组件此刻该说的那句话，没有就不说。
     * @param view - 更新视图状态。
     * @param current - 当前语言的文案表。
     * @returns 正在发生的一步，或 undefined。
     */
    function phaseText(view, current) {
      if (view.failed) return current.update.openFailed;
      const presentation = view.presentation;
      if (presentation === null || typeof presentation !== 'object' || presentation.phase === 'idle') return undefined;
      return updatePhaseText(presentation, current);
    }

    /** `/dsharness/status.json` 里的 `version` 段，或 undefined。 */
    function versionOf(data) {
      return data === null ? undefined : isRecord(data.version) ? data.version : undefined;
    }

    /**
     * 更新组件的状态词：先在状态面里看版本，再看桌面端对话框的失败。
     * @param current - 当前语言的文案表。
     * @param status - 状态面视图。
     * @param view - 更新视图状态。
     * @returns 状态词与状态点语义。
     */
    function updateState(current, status, view) {
      const version = status.phase === 'ready' ? versionOf(status.data) : undefined;
      if (version !== undefined && version.updateAvailable === true) {
        return { word: fill(current.state.available, { version: version.latest ?? '?' }), tone: 'info' };
      }
      if (version !== undefined && typeof version.current === 'string' && version.current !== '') {
        return { word: current.state.latest, tone: 'ok' };
      }
      const presentation = view.presentation;
      if (view.failed || (presentation !== null && typeof presentation === 'object' && presentation.phase === 'error')) {
        return { word: current.state.checkFailed, tone: 'warn' };
      }
      return { word: current.state.unchecked, tone: 'idle' };
    }

    /** 一个组件的状态点。 */
    function dot(tone) {
      return { width: '8px', height: '8px', borderRadius: '999px', flex: 'none', background: TONE[tone] ?? TONE.idle };
    }

    /**
     * 面板里一个组件的一行：名称 + 状态词 + 0..n 条事实。
     * @param key - 组件键（也写进 `data-dsharness-component`，测试与排查都用它）。
     * @param name - 组件名。
     * @param state - 状态词。
     * @param tone - 状态点语义（`ok`/`info`/`warn`/`idle`）。
     * @param facts - 展示性事实，全部是字符串。
     * @param trailing - 行尾控件（更新组件的按钮、复制按钮），没有就不画。
     * @returns 一行元素。
     */
    function componentRow(key, name, state, tone, facts, trailing) {
      const controls = trailing === undefined ? [] : (Array.isArray(trailing) ? trailing : [trailing]);
      return jsxs('div', {
        style: COMPONENT_ROW,
        'data-dsharness-component': key,
        children: [
          jsxs('div', {
            style: COMPONENT_MAIN,
            children: [
              jsxs('div', {
                style: COMPONENT_HEAD,
                children: [
                  jsx('span', { style: dot(tone), 'aria-hidden': 'true' }),
                  jsx('span', { style: COMPONENT_NAME, children: name }),
                  jsx('span', { style: COMPONENT_STATE, role: 'status', children: state }),
                ],
              }),
              facts.length === 0
                ? null
                : jsx('div', {
                  style: FACTS,
                  children: facts.map((fact, index) => jsx('span', { children: fact }, `${key}-fact-${index}`)),
                }),
            ],
          }),
          controls.length === 0
            ? null
            : jsxs('div', { style: COMPONENT_TRAILING, children: controls }),
        ],
      });
    }

    /**
     * 「复制」按钮 + 它旁边那次短暂确认。
     *
     * 值不在 props 里，也不在任何状态里：`copy` 一路把值从取值面带进
     * `navigator.clipboard.writeText`，两边都不落地。所以在按钮上能画出来的
     * 只有结果（「已复制」/「复制失败」），凭据值本身没有渲染路径。
     *
     * 值已知缺席（`tokenConfigured` / `configured` 不为真）时按钮禁用：
     * 那时候点下去只会有一次注定失败的请求。
     * @param key - 组件键，用来拼 `data-dsharness-copy` 与确认的 data 属性。
     * @param label - 按钮文字（当前语言的「复制」）。
     * @param copy - {@link useCopy} 的返回值。
     * @param current - 当前语言的文案表。
     * @returns 按钮与确认的元素数组。
     */
    function copyButton(key, label, copy, current) {
      const notice = copy.outcome === 'copied'
        ? current.panel.copied
        : copy.outcome === 'failed' ? current.panel.copyFailed : undefined;
      return [
        jsx('button', {
          type: 'button',
          style: copy.disabled ? BUTTON_DISABLED : BUTTON,
          disabled: copy.disabled,
          'data-dsharness-copy': key,
          onClick: copy.copy,
          children: label,
        }),
        notice === undefined
          ? null
          : jsx('span', {
            style: COPY_RESULT,
            role: 'status',
            'data-dsharness-copy-result': copy.outcome,
            children: notice,
          }),
      ];
    }

    /**
     * 掩码一个联系方式。
     *
     * 昵称不是联系方式、原样显示；联系方式只显示可辨认的最小片段，
     * 面板上不该出现一个完整的邮箱或手机号。
     * @param contact - 状态面给的 `account.contact`。
     * @returns 掩码后的文本。
     */
    function maskContact(contact) {
      if (typeof contact !== 'string' || contact === '') return undefined;
      const at = contact.indexOf('@');
      if (at > 0) return `${contact.slice(0, 1)}***${contact.slice(at)}`;
      if (contact.length <= 4) return '***';
      return `${contact.slice(0, 3)}****${contact.slice(-4)}`;
    }

    /** 余额一行：货币符号（认识 CNY，其余用代码）+ 金额。 */
    function money(entry) {
      const currency = typeof entry.currency === 'string' ? entry.currency : '';
      const amount = typeof entry.balance === 'string' ? entry.balance : '';
      return currency.toUpperCase() === 'CNY' ? `\u00a5${amount}` : `${currency} ${amount}`.trim();
    }

    /**
     * 四个组件行。读的字段全部来自钉死的只读契约；
     * `tokenConfigured` / `modelKey.configured` 只当布尔用，永不渲染任何密钥值。
     *
     * 「本机网关」与「模型 Key」两行的行尾各有一个复制按钮
     * （用户口径：「本机网关一行右侧要有复制密钥的按钮，点击之后复制共享密钥」
     * 「模型 key 也是，要有复制 key 的按钮」）。两个按钮走同一个 hook，
     * 值只经过点击处理器，不进状态、不进渲染。
     * @param current - 当前语言的文案表。
     * @param data - 状态面响应体，读不到时为 null。
     * @param status - 状态面视图（更新组件用它判断「尚未检查」）。
     * @param update - 更新视图与打开动作。
     * @param gatewayCopy - 本机网关行的复制状态与动作。
     * @param keyCopy - 模型 Key 行的复制状态与动作。
     * @returns 四行的元素数组。
     */
    function componentRows(current, data, status, update, gatewayCopy, keyCopy) {
      const facts = current.fact;
      /*
       * 「运行中 / 未启用」= 共享密钥配没配（`tokenConfigured`）。
       * 这张状态面本身由宿主半回答，所以它一旦有响应，网关就在跑；
       * 而密钥没配时网关那条通道对谁都拒绝（宿主半只警告不挡启动），
       * 所以对用户而言「未启用」才是那句话。
       */
      const gatewayOn = data !== null && data.tokenConfigured === true;
      const gatewayFacts = [];
      if (data !== null && typeof data.port === 'number') gatewayFacts.push(fill(facts.port, { port: data.port }));
      if (data !== null && typeof data.address === 'string') gatewayFacts.push(fill(facts.address, { address: data.address }));
      if (data !== null) gatewayFacts.push(`${facts.sharedSecret}\uff1a${gatewayOn ? facts.configured : facts.unconfigured}`);

      const account = data !== null && isRecord(data.account) ? data.account : undefined;
      const signedIn = account !== undefined && account.signedIn === true;
      const modelKey = data !== null && isRecord(data.modelKey) ? data.modelKey : undefined;
      const keyConfigured = modelKey !== undefined && modelKey.configured === true;
      const keyFacts = data === null ? [] : [
        `${facts.credential}\uff1a${MODEL_KEY_REF}`,
        keyConfigured ? facts.configured : facts.unconfigured,
      ];

      const accountFacts = [];
      if (signedIn) {
        const name = typeof account.name === 'string' && account.name !== '' ? account.name : undefined;
        const contact = name === undefined ? maskContact(account.contact) : undefined;
        if (name !== undefined) accountFacts.push(name);
        else if (contact !== undefined) accountFacts.push(contact);
        const wallets = Array.isArray(account.balance) ? account.balance : [];
        for (const wallet of wallets) {
          if (isRecord(wallet)) accountFacts.push(`${facts.balance}\uff1a${money(wallet)}`);
        }
      }

      const version = status.phase === 'ready' ? versionOf(status.data) : undefined;
      const updateFacts = [
        fill(facts.currentVersion, { version: version !== undefined && typeof version.current === 'string' ? version.current : facts.none }),
        fill(facts.latestVersion, { version: version !== undefined && typeof version.latest === 'string' ? version.latest : facts.none }),
      ];
      const phase = phaseText(update.view, current);
      if (phase !== undefined) updateFacts.push(phase);
      const state = updateState(current, status, update.view);
      const updates = bridge();
      const disabled = updates === undefined || busy(update.view);

      return [
        componentRow('gateway', current.component.gateway,
          data === null ? current.state.unknown : gatewayOn ? current.state.running : current.state.disabled,
          data === null ? 'idle' : gatewayOn ? 'ok' : 'idle', gatewayFacts,
          copyButton('gateway', current.panel.copy, gatewayCopy, current)),
        componentRow('modelKey', current.component.modelKey,
          data === null ? current.state.unknown : signedIn ? keyConfigured ? current.state.synced : current.state.unsynced : current.state.signedOut,
          data === null ? 'idle' : signedIn ? keyConfigured ? 'ok' : 'warn' : 'idle', keyFacts,
          copyButton('modelKey', current.panel.copy, keyCopy, current)),
        componentRow('update', current.component.update, state.word, state.tone, updateFacts,
          jsx('button', {
            type: 'button',
            style: disabled ? BUTTON_DISABLED : BUTTON,
            disabled,
            onClick: update.open,
            children: update.view.opening ? current.update.opening : current.update.action,
          })),
        componentRow('account', current.component.account,
          data === null ? current.state.unknown : signedIn ? current.state.signedIn : current.state.signedOut,
          data === null ? 'idle' : signedIn ? 'ok' : 'idle', accountFacts),
      ];
    }

    /**
     * 插件页卡片自己的配置区：只读的组件状态面板。
     *
     * 卡片用 `{ view: 'page' }` 无条件渲染这一页（`PluginManagerPage.tsx:680`），
     * 所以这里不读 `form`、不假设存在可写配置；`summary` 只回一行字。
     * @param props - owner props：`{ view, form? }`。
     * @returns 面板，或 summary 的一句话。
     */
    function Panel(props) {
      const current = copy();
      const status = useStatus();
      const update = useUpdateView();
      /*
       * 两个复制 hook 必须在早返回**之前**调用：`{ view: 'summary' }` 也走同一个
       * 函数体（`props.view !== 'page'` 只是在后面回一行字），而 hook 的调用顺序
       * 是 React 的硬要求，不能随 props 变化。
       */
      const data = status.phase === 'ready' ? status.data : null;
      const gatewayCopy = useCopy(gatewaySecret, data === null || data.tokenConfigured !== true);
      const keyCopy = useCopy(modelKeySecret, data === null || !isRecord(data.modelKey) || data.modelKey.configured !== true);
      if (props.view !== 'page') return current.panel.summary;
      // `div` 而不是 `section`：卡片页已经把它包在 `data-plugin-config` 的 section 里，
      // 这一层只提供内容，不重复声明 section 语义。
      return jsxs('div', {
        style: PANEL,
        'data-dsharness-panel': 'page',
        children: [
          jsxs('header', {
            style: PANEL_HEAD,
            children: [
              jsx('div', { style: PANEL_TITLE, children: current.panel.title }),
              jsx('div', { style: PANEL_NOTE, children: current.panel.note }),
            ],
          }),
          status.phase === 'error'
            ? jsx('p', { style: NOTICE, role: 'status', children: current.panel.unavailable })
            : null,
          ...componentRows(current, data, status, update, gatewayCopy, keyCopy),
        ],
      });
    }

    /**
     * 「设置 › 通用」里那一行：版本状态 + 一个按钮。
     *
     * owner props 是空的（`settings.general.item` 的 owner 只有 `children?: never`），
     * 所以这一行自己画完自己的全部内容。它和面板是同一个更新组件，不是第二个插件。
     * @returns 这一行的元素树。
     */
    function SettingsRow() {
      const current = copy();
      const status = useStatus();
      const update = useUpdateView();
      const updates = bridge();
      const state = updateState(current, status, update.view);
      const phase = phaseText(update.view, current);
      const line = updates === undefined
        ? current.update.unavailable
        : phase === undefined ? state.word : `${state.word} \u00b7 ${phase}`;
      const disabled = updates === undefined || busy(update.view);
      return jsxs('div', {
        style: ROW,
        children: [
          jsxs('div', {
            children: [
              jsx('div', { style: TITLE, children: current.update.title }),
              jsx('div', { style: DESCRIPTION, children: current.update.description }),
              jsx('div', { style: STATUS, role: 'status', children: line }),
            ],
          }),
          jsx('button', {
            type: 'button',
            style: disabled ? BUTTON_DISABLED : BUTTON,
            disabled,
            onClick: update.open,
            children: update.view.opening ? current.update.opening : current.action,
          }),
        ],
      });
    }

    /**
     * 注册两个面。
     *
     * 两个都用 `slots.inject`：声明来自别的包，apply 顺序无约束，inject 会在声明
     * 就位后注册、声明消失时自动撤回。不声明 `locale`：这一层的文案自带，
     * 声明了框架会去找一个没人注册过的命名空间。
     * @param ctx - 客户端根上下文（`slots` 由 inject 声明保证就绪）。
     */
    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsharness',
      }, Panel));
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'dsharness',
        order: 90,
        label: () => copy().action,
      }, SettingsRow));
    }

    /** 只依赖 slots 服务。 */
    const inject = ['slots'];

    return { apply, inject };
  },
});
