/**
 * dsharness — 本产品自带的**唯一**插件：一个组合包，四个组件。
 *
 * ## 为什么合成一个
 *
 * 用户口径：「可以把 dshddesktop 网关、模型 key、检查更新、应用内检查更新这些
 * 插件合并成码农 DSH 插件，其中包了多个组件。该插件虽然是已安装的自定义插件，
 * 但是是不可以关闭的」。
 *
 * 合并之前它们是四个各自独立的组合包（`dsharness-model-key`、
 * `dsharness-update`、`dsharness-update-ui`、`dsharness-host-auth`），
 * 在「插件」页上是四张卡片；而且「检查更新」与「应用内检查更新」是两张卡、
 * 两套文案、同一件事 —— 用户看到的就是重复。
 *
 * 现在只有一个包 `dsharness`，只插一行（`id: dsharness`），四个组件由本文件的
 * `apply` 用 `ctx.plugin(...)` 挂成**子插件**（Cordis 的原生形态：一行可以是
 * 一个插件树）。于是插件页上只有一张卡，四个组件的行为与代码原样保留。
 *
 * ## 为什么这一行「关不掉」
 *
 * `platform/provision.mjs` 生成的 `cordis.patch.yml` 在同一份 patch 里多插了一行
 * **没有 id 的**影子行：
 *
 * ```yaml
 * - name: '@deepseek-ai/dsh-plugin-manager'
 *   disabled: true
 * ```
 *
 * 官方 `PluginManager.protectsManager(name)`（`packages/boot/plugin-manager/src/index.ts:763-773`）
 * 只要这个包插进去的**任意一行**的 `name` 命中 `protectedModules`（`:66-76` 里
 * 就有 `@deepseek-ai/dsh-plugin-manager`），就把整个包标成
 * `readOnlyReason: 'management-required'`，于是：
 *
 * - `listBundles()` 回 `removable: false` → 卸载按钮禁用；
 * - `setBundleEnabled('dsharness', false)` 抛 `management-required` → 开关禁用；
 * - `removeBundle('dsharness')` 抛 `not-removable`。
 *
 * 三个都**实测**过（真 `boot()` + 真 `PluginManager`）。要点：
 *
 * - 影子行**不能有 `id`**：`declaredRows` 只收 `typeof row.id === 'string'` 的行，
 *   所以它不会出现在卡片的行列表里 —— 用户看不到一个幽灵行。
 * - 影子行 `disabled: true`，而 Loader 对 disabled 行**在 `init()` 之前就返回**
 *   （`vendor/loader/src/config/entry.ts:136-139`），所以那个 `name` **不需要真的
 *   解析得到**，也就不会引入一份多余的模块依赖。
 *
 * ## 面板只显示状态，不显示密钥
 *
 * 用户口径：「插件的组件中只是显示组件状态，而不需要显示 key 的信息」。
 * 所以 `GET /dsharness/status.json` **只**回布尔与版本号：`tokenConfigured`
 * 与 `modelKey.configured` 是布尔，从不回密钥值或模型 Key 的值。唯一显示密钥的
 * 面仍是 `/dsharness/gateway`（只在回环上渲染，且那是给运行 DSH 的人自己看的）。
 *
 * ## 为什么是一个文件
 *
 * 组合包由 `provision.mjs` 生成：**入口只有一个文件**（`index.mjs`），包目录里
 * 没有 `node_modules`。所以四个组件必须是同一个模块，且只能 import `node:`
 * 内置模块与全局 `fetch`。
 *
 * ## 与上游的关系
 *
 * **上游一行未改。** 本文件在上游不存在的 `platform/` 目录里，
 * `git merge upstream/master` 不会碰到它。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 稳定插件名（Cordis 用它做 fiber 标识与 dispose 归属）。 */
export const name = 'dsharness'

/**
 * 发送方标识。
 *
 * ⚠️ 生产 nginx 有一条反滥用规则：`User-Agent` 以 `node` 开头一律 **403**
 * （Node 的 `fetch` 默认 UA 就是 `node`）。所以每个出网请求都要显式设它，
 * 否则拿到的是 HTML 403 而不是 JSON，排查时极具误导性。
 */
export const USER_AGENT = 'dsharness-client/0.1'

/** HTML 转义。值本来就只含 `[A-Za-z0-9_-]` 时也转义：先拼后想正是这类页面的出错方式。 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** JSON 响应（一律不缓存：这几面显示的是按键与实时状态）。 */
export function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/* ===========================================================================
 * 组件一：本机网关（原 `host-auth.mjs`）
 *
 * 让**服务端到服务端**的调用方用一个共享密钥就能打 DSH 的 `/api`。
 *
 * 官方 `/api` 的认证是 `dsh-client-connection` 的
 * `isTrustedApiRequest`（Host/Origin 围栏）+ `BrowserAuth.isAuthenticated`
 * （只认它自己签发的 `dsh-auth-<hash(authority)>` cookie）。那个 cookie 由
 * `dsh web` 启动时打印的 `?token=` 在 `GET /` 上换得，是**进程内私有**的。
 * 于是「小程序 / 外部产品 / 脚本」这类没有人坐在浏览器前的调用方进不来。
 *
 * 本组件给 `/api` 增加一条**等价的凭据**：正确的共享密钥
 * （`Authorization: Bearer <密钥>`，或本组件自己发的 cookie）会被换算成
 * 一次性的连接 cookie，追加到本次请求上，再由官方原有的认证逻辑放行。
 *
 * **这不是第二套鉴权**：官方那两层照常执行；本组件只是补一个它认得的 cookie。
 * 未配置密钥或密钥短于 16 位时整条通道不启用。比较用 `timingSafeEqual`。
 *
 * 为什么包装服务方法而不是注册路由：`webServer.register` 对同一个 (kind, path)
 * 重复注册会抛错，`/api` 已被 `dsh-client-connection` 占了；而升级握手
 * `/api/remote.mux` 又由 `api-gateway` 单独注册。两处放行判断最终都汇到
 * `connection` 的 `requestRejection` / `authorizeIndex` 上，所以一处包装同时覆盖：
 *
 * | 通道 | 谁调用 | 被包装后放行的入口 |
 * |------|--------|-------------------|
 * | `/api/*`（unary RPC） | `connection` 与 `api-gateway` | `requestRejection` |
 * | `/api/remote.mux`（WebSocket） | `api-gateway` 的 upgrade | `requestRejection` |
 * | `GET /`（页面本身） | web-app 的 dist server | `authorizeIndex` |
 * ======================================================================== */

/** 密钥最短长度；与官方连接 cookie 的强度对齐。 */
export const MIN_TOKEN_LENGTH = 16

/** 连接 cookie 的前缀（`dsh-auth-<base64url(sha256(authority))>`）。 */
export const CONNECTION_COOKIE_PREFIX = 'dsh-auth-'

/** 本组件给浏览器发的 cookie 名。 */
export const DEFAULT_COOKIE = 'dsharness_auth'

/** 本组件自己的登录页路径（避开 SPA fallback）。 */
export const LOGIN_PATH = '/dsharness/auth'

/**
 * 「网关信息」页路径 —— 把**本机监听端口**与**共享密钥**显示给运行 DSH 的人。
 *
 * 为什么需要这一页：插件装好之后，「打哪个端口、带什么密钥」只存在于进程内存里。
 * `dsh web` 只在启动那一次把 `?token=` 打到终端，而桌面端连终端都没有 ——
 * 于是外部调用方根本不知道往哪打、带什么，也就是「无法对接」。
 */
export const STATUS_PATH = '/dsharness/gateway'

/** 同一份事实的 JSON 面，给调用方与验收脚本用，不必解析 HTML。 */
export const STATUS_JSON_PATH = '/dsharness/gateway.json'

/**
 * 只读状态面板的数据面（`platform/dsharness-ui.js` 消费它）。
 *
 * ⚠️ 这一面**不含任何密钥**：只有布尔、端口、版本与余额。所以它可以和上面两条
 * 一样进 {@link PUBLIC_PATHS} —— 它是「集群长什么样」，不是「凭据是什么」。
 */
export const PANEL_JSON_PATH = '/dsharness/status.json'

/**
 * 公开路径：即使连接层拒了请求，也必须能读到的那几条。
 *
 * `frontend-static` 把 `/` 交给 `ctx.connection.authorizeIndex`，**先拒绝就
 * 直接结束响应**。而 `authorizeIndex` 只放行 `GET /`（带 cookie / 启动 token），
 * 所以本组件自己的路径必须在这里放行，否则它们的可读性取决于**路由注册顺序**。
 * `GET` 之外的方法不放行。
 */
export const PUBLIC_PATHS = [LOGIN_PATH, STATUS_PATH, STATUS_JSON_PATH, PANEL_JSON_PATH]

/**
 * 自动生成并持久化密钥时用的凭据引用名。
 *
 * ⚠️ 写**字面量**而不是 `credentialRef('DSHARNESS_AUTH_TOKEN')`：本文件零依赖，
 * import 不到 `@deepseek-ai/dsh-credentials`；而 `credentialRef` 只是校验并打 brand，
 * 运行时值就是这个字符串本身。
 */
export const TOKEN_REF = 'DSHARNESS_AUTH_TOKEN'

/** 自动生成密钥的字节数（base64url 之后 43 字符，远高于 {@link MIN_TOKEN_LENGTH}）。 */
export const GENERATED_TOKEN_BYTES = 32

/**
 * 代铸 cookie 的有效期。**故意很短**：cookie 每次请求现铸，只需活过这一次请求。
 * 取短值还顺带绕开一个坑 —— 官方连接层拒绝
 * `expiresAt - issuedAt` 超过它自己 `cookieMaxAgeDays`（默认 30 天）的 cookie。
 */
export const DEFAULT_MINT_MAX_AGE_SEC = 3600

/** HTTP 头查找（同时支持 Node 的普通对象与 Fetch 的 `Headers`）。 */
function header(headers, key) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') return headers.get(key) ?? undefined
  const value = headers[key]
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined
  return typeof value === 'string' ? value : undefined
}

/** 回环 host 判断（与官方 `loopback-hostname` 的同口径子集）。 */
export function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/** 定长安全比较：长度不同也走完，不提前返回。 */
export function safeEqualString(actual, expected) {
  const a = Buffer.from(String(actual ?? ''), 'utf8')
  const b = Buffer.from(String(expected ?? ''), 'utf8')
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

/** 取一条请求携带的**共享密钥**：先看 `Authorization: Bearer`，再看本组件自己的 cookie。 */
export function presentedSecret(request, cookieName = DEFAULT_COOKIE) {
  const authorization = header(request?.headers, 'authorization')
  if (typeof authorization === 'string') {
    const match = /^Bearer[ \t]+(.+)$/i.exec(authorization.trim())
    if (match !== null) {
      const value = match[1].trim()
      if (value !== '') return value
    }
  }
  return cookieValue(header(request?.headers, 'cookie'), cookieName)
}

/** 从 Cookie 头里取一个具名 cookie（只实现这一种生成格式所需的最小子集）。 */
export function cookieValue(cookieHeader, cookieName) {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return undefined
  for (const segment of cookieHeader.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== cookieName) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** base64url（官方 `browser-auth.ts` 的同口径实现）。 */
export function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/** 请求 authority（Cookie 名与签名受众都用它）。 */
export function requestAuthority(headers) {
  const host = header(headers, 'host')
  if (typeof host !== 'string' || host === '') return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

/** 官方连接 cookie 的名字。 */
export function connectionCookieName(authority) {
  return CONNECTION_COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/**
 * 用连接层自己的签名密钥铸一个它认得的 cookie。
 *
 * 格式必须与 `packages/client/connection/src/browser-auth.ts` 的 `encodeCookie`
 * 逐字节一致：`v1.<base64url(json)>.<base64url(hmacSha256(body))>`，
 * json 是 `{version:1, authority, issuedAt, expiresAt}`。格式漂移由挂载时的自检
 * （`verifyMinting`）当场发现。
 */
export function mintConnectionCookie(authority, secret, maxAgeSec, now = Date.now()) {
  const issuedAt = now
  const expiresAt = now + maxAgeSec * 1000
  const payload = { version: 1, authority, issuedAt, expiresAt }
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signature = createHmac('sha256', secret).update(body).digest()
  return { name: connectionCookieName(authority), value: `v1.${body}.${encodeBase64Url(signature)}` }
}

/** 把一段 `name=value` 追加进 Cookie 头（不覆盖调用方已有的 cookie）。 */
export function appendCookie(headers, pair) {
  const existing = header(headers, 'cookie')
  const merged = typeof existing === 'string' && existing !== ''
    ? `${existing}; ${pair.name}=${pair.value}`
    : `${pair.name}=${pair.value}`
  if (typeof headers.set === 'function') headers.set('cookie', merged)
  else headers.cookie = merged
}

/** 解析连接凭据记录里的签名密钥（官方 `storedSecret` 的同口径）。 */
export function decodeStoredSecret(record) {
  if (record === undefined || record === null) return undefined
  if (record.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) return undefined
  if (record.payload.version !== 1 || typeof record.payload.secret !== 'string') return undefined
  const decoded = Buffer.from(
    record.payload.secret.replaceAll('-', '+').replaceAll('_', '/'),
    'base64',
  )
  return decoded.byteLength === 32 ? decoded : undefined
}

/**
 * 生成一把共享密钥。
 *
 * base64url 的字符集（`A-Za-z0-9-_`）正好落在 {@link MIN_TOKEN_LENGTH} 的上限之外，
 * 也不会被 URL 或 YAML 转义弄坏。
 *
 * @returns 43 字符的随机密钥。
 */
export function generateToken() {
  return randomBytes(GENERATED_TOKEN_BYTES).toString('base64url')
}

/**
 * 解析网关组件配置：`config.token` 优先，其次环境变量，都没有（或太短）就**生成一把**。
 *
 * ## 为什么没有配置也要生成一把
 *
 * 用户口径：「网关插件要能显示端口和令牌，否则我无法对接」——**显示**的前提是
 * 真的有一把令牌。此前 `token: ''` ⇒ `enabled: false` ⇒ 插件根本不挂载，
 * 于是既没有通道、也没有任何可显示的东西。现在未配置时生成一把随机值，由 `apply`
 * 写进凭据层（{@link TOKEN_REF}），下次启动由部署行读回来，所以它在进程之间稳定。
 *
 * ## 「关掉这条通道」只认 `enabled: false`
 *
 * 部署行给的是 `token: !!js process.env.DSH_AUTH_TOKEN ?? ''`，也就是**总是**给出
 * `token` 键（没配环境变量时是空串）。所以「显式空串＝关掉它」这条老口径已经表达
 * 不了意图：空串必须按「未配置」处理。唯一的开关是 `enabled: false`。
 *
 * ## 太短的声明值会被换掉，但必须可诊断
 *
 * `rejectedDeclared` 单独标出，否则用户会以为自己的配置生效了。
 *
 * @param config - 组件配置；无 schema。
 * @param generate - 生成器，测试可注入。
 * @returns 归一后的设置。
 */
export function resolveGatewayConfig(config = {}, generate = generateToken) {
  const raw = config ?? {}
  const declared = Object.hasOwn(raw, 'token') ? raw.token : process.env.DSH_AUTH_TOKEN
  const configured = String(declared ?? '').trim()
  const usable = configured.length >= MIN_TOKEN_LENGTH
  const token = usable ? configured : generate()
  const enabled = raw.enabled !== false && token.length >= MIN_TOKEN_LENGTH
  return {
    enabled,
    token,
    /** 密钥是不是本次生成的（调用方据此决定要不要持久化）。 */
    generated: !usable,
    /** 声明过密钥但短于下限，因此被换掉。 */
    rejectedDeclared: !usable && configured.length > 0,
    cookieName: String(raw.cookieName ?? DEFAULT_COOKIE).trim() || DEFAULT_COOKIE,
    cookieMaxAgeSec: Number.isFinite(Number(raw.cookieMaxAgeSec)) && Number(raw.cookieMaxAgeSec) > 0
      ? Math.floor(Number(raw.cookieMaxAgeSec))
      : DEFAULT_MINT_MAX_AGE_SEC,
    loginPage: raw.loginPage !== false,
    /*
     * 状态面板要读版本清单，而清单在本产品的服务端上。这一项不单列配置键：
     * 与「检查更新」组件用同一个来源（`origin`，退回环境变量与出厂 origin），
     * 否则安装好的机器上会出现「面板说有新版、更新页说没有」。
     */
    platformOrigin: String(raw.origin ?? process.env.DSH_PLATFORM_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, ''),
  }
}

/** 登录页（局域网里的浏览器用它把手上的密钥换成 cookie）。 */
function loginPageHtml() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    '<title>DSH 本机鉴权</title>',
    '<style>',
    ':root{color-scheme:light dark}body{font:14px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}',
    'form{width:min(420px,92vw);padding:24px;border:1px solid #8883;border-radius:12px}',
    'h1{font-size:16px;margin:0 0 12px}input{width:100%;padding:10px;border:1px solid #8884;border-radius:8px;font:inherit}',
    'button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:#4d6bfe;color:#fff;font:inherit;cursor:pointer}',
    'p{color:#6b7280;font-size:12px;margin:12px 0 0}#notice{margin-top:10px;font-size:12px}',
    '</style></head><body>',
    '<form id="f"><h1>这台 DSH 需要密钥</h1>',
    '<input id="token" type="password" autocomplete="off" placeholder="共享密钥" />',
    '<button type="submit">进入</button>',
    '<p>密钥由运行 DSH 的人提供（与设置里的 Host 鉴权密钥是同一个）。</p>',
    '<div id="notice"></div></form>',
    '<p>要对接本机 API 的一方，端口与共享密钥都在 <a href="/dsharness/gateway">/dsharness/gateway</a>。</p>',
    '<script>',
    '(function(){var f=document.getElementById("f"),t=document.getElementById("token"),n=document.getElementById("notice");',
    'f.addEventListener("submit",function(e){e.preventDefault();n.textContent="";',
    'fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:t.value})})',
    '.then(function(r){return r.json().then(function(b){return {ok:r.ok,b:b}})}).then(function(r){',
    'if(r.ok&&r.b&&r.b.ok){location.replace("/");return}n.textContent=(r.b&&r.b.message)||"密钥不正确"})',
    '.catch(function(){n.textContent="无法连接"})});})();',
    '</script></body></html>',
    '',
  ].join('\n')
}

/**
 * 网关信息页 —— **本机监听端口**与**共享密钥**，给要对接的人看。
 *
 * 三点刻意的设计：
 *
 * - **只在回环上渲染**。请求的 Host 不是回环时（被人把局域网地址发出去），
 *   这一页回一个不含凭据的说明。密钥只应出现在运行 DSH 的这台机器上。
 * - **端口取自本次请求的 authority**，而不是另存一份配置：`webServer.port`
 *   在 `port: 0`（系统分配）时只有监听之后才知道，而 authority 就是调用方
 *   实际打过来的那个 `host:port`，它一定是对的。
 * - **不带 `?token=`**。`dsh web` 启动 URL 里那个 token 是连接层的一次性凭据
 *   （本组件拿不到也不需要），与共享密钥是两回事。
 *
 * @param settings - 已解析的组件配置。
 * @param authority - 本次请求的 authority（`host:port`）。
 * @returns 页面 HTML。
 */
export function gatewayPageHtml(settings, authority) {
  const port = String(authority).slice(String(authority).lastIndexOf(':') + 1)
  const rows = [
    ['端口', `<code>${escapeHtml(port)}</code>`],
    ['本机地址', `<code>http://${escapeHtml(authority)}</code>`],
    ['共享密钥', `<code id="token">${escapeHtml(settings.token)}</code>`],
    ['Cookie 名', `<code>${escapeHtml(settings.cookieName)}</code>`],
    ['登录页', `<code>${escapeHtml(LOGIN_PATH)}</code>`],
    ...settings.generated
      ? [['来源', `<code>本次自动生成，已写入本机凭据（${escapeHtml(TOKEN_REF)}）</code>`]]
      : [],
  ]
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    '<title>DSH Desktop 网关</title>',
    '<style>',
    ':root{color-scheme:light dark}body{font:14px/1.7 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}',
    'main{width:min(720px,94vw);padding:24px;border:1px solid #8883;border-radius:12px}',
    'h1{font-size:16px;margin:0 0 4px}p.lead{color:#6b7280;font-size:12px;margin:0 0 16px}',
    'table{border-collapse:collapse;width:100%}th{text-align:left;font-weight:400;color:#6b7280;width:9em;padding:6px 8px 6px 0;vertical-align:top}',
    'td{padding:6px 0;word-break:break-all}code{font-family:ui-monospace,monospace}',
    'button{margin-top:16px;padding:8px 14px;border:0;border-radius:8px;background:#4d6bfe;color:#fff;font:inherit;cursor:pointer}',
    '#notice{margin-top:10px;font-size:12px;color:#6b7280}',
    '</style></head><body><main>',
    '<h1>DSH Desktop 网关</h1>',
    '<p class="lead">把这个端口与密钥给要对接的一方：请求带 <code>Authorization: Bearer &lt;共享密钥&gt;</code> 即可访问本机 Harness API。仅在本机可用。</p>',
    '<table>',
    ...rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`),
    '</table>',
    '<button id="copy" type="button">复制密钥</button>',
    '<div id="notice"></div></main>',
    '<script>',
    '(function(){var b=document.getElementById("copy"),n=document.getElementById("notice"),t=document.getElementById("token");',
    'b.addEventListener("click",function(){var v=t.textContent||"";',
    'var done=function(){n.textContent="已复制"};',
    'if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(done,function(){n.textContent="复制失败，请手动选中上面那行"})}',
    'else{n.textContent="请手动选中上面那行复制"}});})();',
    '</script></body></html>',
    '',
  ].join('\n')
}

/** 非回环请求看到的说明（不含任何凭据）。 */
export function offHostPageHtml() {
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8" /><title>DSH Desktop 网关</title></head>',
    '<body><p>这一页只在运行 DSH 的机器上（回环地址）可读，因为它显示共享密钥。</p></body></html>',
    '',
  ].join('\n')
}

/** 读取请求体（限长，避免把内存交给陌生人）。 */
function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { resolve(''); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', () => { resolve('') })
  })
}

/**
 * 本机网关组件。
 *
 * `credentials` **刻意不写进 `inject`**：拿不到签名密钥时应当退化成
 * 「不代铸 cookie（记一条 warn）」，而不是「插件挂不上、整条通道消失」。
 */
export const gatewayComponent = {
  name: 'dsharness/gateway',
  inject: ['connection'],
  apply(ctx, config) {
    const settings = resolveGatewayConfig(config)
    if (!settings.enabled) {
      ctx.logger.warn(
        `[${name}/gateway] 未启用：需要 ≥${MIN_TOKEN_LENGTH} 位的共享密钥`
        + `（配置项 gateway.token，或环境变量 DSH_AUTH_TOKEN）。/api 保持官方默认行为。`,
      )
      return
    }

    const connection = ctx.connection
    /** 连接层签名密钥；首次用到时异步读入并缓存（`requestRejection` 是同步的）。 */
    let secret
    let loading

    const credentials = ctx.get('credentials')

    /*
     * 把自动生成的密钥持久化，让它在进程之间稳定。
     *
     * 为什么必须持久化：页面显示的那把密钥就是对接方要长期使用的那把。若每次启动
     * 都重新生成，用户抄下来的那一把下次启动就失效 —— 那不是「显示令牌」，
     * 而是「显示一个正在过期的令牌」。写进凭据层后，部署行的
     * `!!js process.env.DSH_AUTH_TOKEN ?? ''` 之外还有第二处稳定来源。
     *
     * 失败只记一条：读不到凭据层时插件仍然可用（本次进程内密钥有效）。
     */
    if (settings.generated && credentials !== undefined) {
      if (settings.rejectedDeclared) {
        ctx.logger.warn(
          `[${name}/gateway] 配置的密钥短于 ${MIN_TOKEN_LENGTH} 位，已换成本次生成的随机值`
          + `（这条通道此前会整体不启用；改配置项 gateway.token 或 DSH_AUTH_TOKEN）`,
        )
      }
      void Promise.resolve()
        .then(() => credentials.set(TOKEN_REF, settings.token))
        .then(() => {
          ctx.logger.info(`[${name}/gateway] 已生成并保存共享密钥（${TOKEN_REF}），可在 ${STATUS_PATH} 查看`)
        })
        .catch((error) => {
          ctx.logger.warn(
            `[${name}/gateway] 未能保存生成的密钥（${error instanceof Error ? error.message : String(error)}）；`
            + `本进程内有效，重启后会变`,
          )
        })
    }

    function ensureSecret() {
      if (secret !== undefined || loading !== undefined || credentials === undefined) return
      loading = Promise.resolve()
        .then(() => credentials.readRecord('client-connection/browser-session'))
        .then((record) => {
          const decoded = decodeStoredSecret(record)
          if (decoded === undefined) {
            ctx.logger.warn(`[${name}/gateway] 连接凭据格式不认识，暂不代铸 cookie`)
            return
          }
          secret = decoded
        })
        .catch((error) => {
          ctx.logger.warn(`[${name}/gateway] 读取连接凭据失败：${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => { loading = undefined })
    }

    ensureSecret()

    /** 请求带了正确密钥就把连接 cookie 补上。@returns 是否补过。 */
    function admit(request) {
      if (credentials === undefined) return false
      const presented = presentedSecret(request, settings.cookieName)
      if (presented === undefined || !safeEqualString(presented, settings.token)) return false
      ensureSecret()
      if (secret === undefined) return false
      const authority = requestAuthority(request?.headers)
      if (authority === undefined) return false
      appendCookie(request.headers, mintConnectionCookie(authority, secret, settings.cookieMaxAgeSec))
      return true
    }

    /*
     * 自检：拿自己铸的 cookie 走一遍官方校验。
     *
     * 这是**格式漂移的报警器** —— 上游改了 cookie 结构时，与其等到线上 401，
     * 不如在挂载时就喊出来。
     */
    function verifyMinting() {
      if (secret === undefined) { ensureSecret(); return }
      const authority = `127.0.0.1:${String(ctx.get('webServer')?.port ?? 1)}`
      const pair = mintConnectionCookie(authority, secret, settings.cookieMaxAgeSec)
      const probe = { headers: { host: authority, cookie: `${pair.name}=${pair.value}` } }
      try {
        const rejection = connection.requestRejection(probe)
        if (rejection !== undefined) {
          ctx.logger.warn(
            `[${name}/gateway] 连接 cookie 格式可能与上游漂移（自检得到 ${String(rejection)}），`
            + '小程序 / 脚本通道可能失效，请对照 packages/client/connection/src/browser-auth.ts',
          )
        }
      } catch (error) {
        ctx.logger.warn(`[${name}/gateway] 自检失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const originalRejection = connection.requestRejection
    const wrappedRejection = function (request) {
      try { admit(request) } catch (error) {
        ctx.logger.warn(`[${name}/gateway] 代铸 cookie 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return originalRejection.call(this, request)
    }
    connection.requestRejection = wrappedRejection

    const originalAuthorizeIndex = connection.authorizeIndex
    const wrappedAuthorizeIndex = function (request, response) {
      // 浏览器带本组件 cookie 打开页面时，同样先换成连接 cookie，
      // 否则首页会 401（页面本身的认证不走 requestRejection）。
      try { admit(request) } catch (error) {
        ctx.logger.warn(`[${name}/gateway] 代铸 cookie 失败：${error instanceof Error ? error.message : String(error)}`)
      }
      // 本组件自己的那几条路径永远放行（GET）：它们是「看得见的凭据」这一面，
      // 而 authorizeIndex 只认 `GET /`，先拒绝就直接结束响应了。
      const url = new URL(request.url ?? '/', 'http://dsh.invalid')
      if (request.method === 'GET' && PUBLIC_PATHS.includes(url.pathname)) return true
      return originalAuthorizeIndex.call(this, request, response)
    }
    connection.authorizeIndex = wrappedAuthorizeIndex

    ctx.effect(() => () => {
      if (connection.requestRejection === wrappedRejection) connection.requestRejection = originalRejection
      if (connection.authorizeIndex === wrappedAuthorizeIndex) connection.authorizeIndex = originalAuthorizeIndex
    }, `${name}/gateway: connection credential equivalence`)

    /** 回环判断：这一页显示密钥，只应在运行 DSH 的这台机器上可读。 */
    function isLoopbackRequest(request) {
      const authority = requestAuthority(request?.headers)
      if (authority === undefined) return false
      const host = authority.slice(0, authority.lastIndexOf(':'))
      return isLoopbackHostname(host.replace(/^\[|\]$/g, ''))
    }

    if (settings.loginPage) {
      ctx.inject(['webServer'], (webCtx) => {
        webCtx.effect(() => webCtx.webServer.register({
          kind: 'exact',
          path: LOGIN_PATH,
          handler: async (req, res) => {
            if (req.method === 'GET' || req.method === 'HEAD') {
              const html = loginPageHtml()
              res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': String(Buffer.byteLength(html)),
              })
              res.end(req.method === 'HEAD' ? undefined : html)
              return
            }
            if (req.method !== 'POST') {
              res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, message: '只支持 GET 与 POST' }))
              return
            }
            let token = ''
            try {
              const parsed = JSON.parse(await readBody(req))
              token = typeof parsed?.token === 'string' ? parsed.token.trim() : ''
            } catch { /* 非法 JSON 走下面的拒绝分支 */ }
            if (!safeEqualString(token, settings.token)) {
              res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, message: '密钥不正确' }))
              return
            }
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'set-cookie': `${settings.cookieName}=${encodeURIComponent(settings.token)};`
                + ' Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000',
            })
            res.end(JSON.stringify({ ok: true }))
          },
        }), `${name}/gateway: ${LOGIN_PATH}`)

        /*
         * 网关信息面 —— 用户口径：「网关插件要能显示端口和令牌，否则我无法对接」。
         *
         * 这一面只在**回环**上回凭据：它显示的是长期共享密钥，被人把局域网地址
         * 发出去就等于把密钥发出去。非回环请求得到同一页的「去本机看」说明。
         */
        webCtx.effect(() => webCtx.webServer.register({
          kind: 'exact',
          path: STATUS_PATH,
          handler: (req, res) => {
            if (req.method === 'HEAD') { res.writeHead(200, { 'cache-control': 'no-store' }); res.end(); return }
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, message: '只支持 GET' })
              return
            }
            if (!isLoopbackRequest(req)) {
              const html = offHostPageHtml()
              res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                'content-length': String(Buffer.byteLength(html)),
              })
              res.end(html)
              return
            }
            const authority = requestAuthority(req.headers) ?? `127.0.0.1:${String(webCtx.webServer.port)}`
            const html = gatewayPageHtml(settings, authority)
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': String(Buffer.byteLength(html)),
            })
            res.end(html)
          },
        }), `${name}/gateway: ${STATUS_PATH}`)

        /* 同一份事实的 JSON 面，给调用方与验收脚本用，不必解析 HTML。 */
        webCtx.effect(() => webCtx.webServer.register({
          kind: 'exact',
          path: STATUS_JSON_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, message: '只支持 GET' })
              return
            }
            if (!isLoopbackRequest(req)) {
              sendJson(res, 403, { ok: false, message: '共享密钥只在运行 DSH 的机器上可读' })
              return
            }
            const authority = requestAuthority(req.headers) ?? `127.0.0.1:${String(webCtx.webServer.port)}`
            sendJson(res, 200, {
              ok: true,
              port: Number(authority.slice(authority.lastIndexOf(':') + 1)),
              address: `http://${authority}`,
              token: settings.token,
              generated: settings.generated,
              cookieName: settings.cookieName,
              loginPath: LOGIN_PATH,
              statusPath: STATUS_PATH,
              tokenRef: TOKEN_REF,
            })
          },
        }), `${name}/gateway: ${STATUS_JSON_PATH}`)

        /*
         * 只读状态面板的数据面（`platform/dsharness-ui.js`）。
         *
         * ⚠️ 这一面**绝不含密钥**：只有端口、布尔、版本与余额。它被
         * `httpHeaders` 之外的代码消费（浏览器里的插件页 / 设置页），所以：
         *
         * - 非回环 403（同 gateway.json，凭据只在本机可读）；
         * - `version` 复用「检查更新」组件的那次远端查询，并带一个 ≤60s 的 TTL
         *   缓存 —— 面板每 10 秒轮询一次，不缓存就会把产品服务端打成了探针；
         * - `account` / `modelKey` 全部 `ctx.get(...)` 取，取不到就降级：
         *   面板少一行状态，而不是整面 500。
         */
        const PANEL_TTL_MS = 60_000
        let versionCache = { at: 0, value: undefined }

        /** 面板里的版本段；一次远端失败不缓存，下次轮询会重试。 */
        const panelVersion = async () => {
          const now = Date.now()
          if (versionCache.value !== undefined && now - versionCache.at < PANEL_TTL_MS) return versionCache.value
          const record = readInstallRecord(String(process.env.DSH_HOME ?? join(homedir(), '.dsh')))
          const current = record?.version ?? null
          try {
            const result = await checkForUpdate({
              origin: settings.platformOrigin,
              home: String(process.env.DSH_HOME ?? join(homedir(), '.dsh')),
              requestTimeoutMs: REQUEST_TIMEOUT_MS,
            })
            const value = {
              current: result.current ?? current,
              latest: typeof result.latest === 'string' ? result.latest : null,
              updateAvailable: result.updateAvailable === true,
            }
            versionCache = { at: now, value }
            return value
          } catch {
            return { current, latest: null, updateAvailable: false }
          }
        }

        /** 凭据层里模型 Key 配没配 —— 只回布尔，从不回值。 */
        const panelModelKey = async () => {
          const store = webCtx.get('credentials')
          if (store === undefined) return { ref: MODEL_KEY_REF, configured: false }
          try {
            const info = await store.describe(MODEL_KEY_REF)
            return { ref: MODEL_KEY_REF, configured: info?.configured === true }
          } catch {
            return { ref: MODEL_KEY_REF, configured: false }
          }
        }

        /** 账号与费用：登录状态 + 钱包余额。任一服务缺席或失败都降级成未登录。 */
        const panelAccount = async () => {
          const account = webCtx.get('deepseekAccount')
          const empty = { signedIn: false, name: null, contact: null, balance: [] }
          if (account === undefined) return empty
          let session
          try {
            session = await account.getPlatformSession()
          } catch {
            return empty
          }
          if (session === null || session === undefined) return empty
          const result = { ...empty, signedIn: true }
          try {
            const profile = await account.getProfile({
              version: readInstallRecord(String(process.env.DSH_HOME ?? join(homedir(), '.dsh')))?.version ?? '0.0.0',
              locale: 'zh',
              timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
            })
            if (profile?.status === 'ready') {
              result.name = profile.value.name ?? null
              result.contact = profile.value.contact ?? null
            }
          } catch { /* 资料读不到不影响「已登录」这个事实 */ }
          try {
            const balance = await account.getBalance({
              version: readInstallRecord(String(process.env.DSH_HOME ?? join(homedir(), '.dsh')))?.version ?? '0.0.0',
              locale: 'zh',
              timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
            })
            if (balance?.status === 'ready') {
              result.balance = [...balance.value, ...balance.bonusWallets]
                .map((wallet) => ({ currency: wallet.currency, balance: wallet.balance }))
            }
          } catch { /* 余额读不到时列表留空 */ }
          return result
        }

        webCtx.effect(() => webCtx.webServer.register({
          kind: 'exact',
          path: PANEL_JSON_PATH,
          handler: async (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, message: '只支持 GET' })
              return
            }
            if (!isLoopbackRequest(req)) {
              sendJson(res, 403, { ok: false, message: '状态只在运行 DSH 的机器上可读' })
              return
            }
            const authority = requestAuthority(req.headers) ?? `127.0.0.1:${String(webCtx.webServer.port)}`
            /*
             * 三段并行取，任一段失败只让它自己为空：面板最需要的是端口与版本，
             * 不该因为余额查询超时而整面读不到。
             */
            const [version, modelKey, account] = await Promise.all([
              panelVersion().catch(() => ({ current: null, latest: null, updateAvailable: false })),
              panelModelKey(),
              panelAccount(),
            ])
            sendJson(res, 200, {
              ok: true,
              port: Number(authority.slice(authority.lastIndexOf(':') + 1)),
              address: `http://${authority}`,
              tokenConfigured: settings.enabled === true && settings.token.length >= MIN_TOKEN_LENGTH,
              cookieName: settings.cookieName,
              loginPath: LOGIN_PATH,
              gatewayPath: STATUS_PATH,
              version,
              modelKey,
              account,
              checkedAt: new Date().toISOString(),
            })
          },
        }), `${name}/gateway: ${PANEL_JSON_PATH}`)
      })
    }

    // 自检放在密钥读进来之后；密钥是异步读的，用一个微任务批次跟一次。
    void Promise.resolve().then(() => {
      const wait = () => {
        if (secret !== undefined || loading === undefined) { verifyMinting(); return }
        void loading.then(() => { wait() }, () => { wait() })
      }
      wait()
    })

    ctx.logger.info(
      `[${name}/gateway] 已启用：Bearer / ${settings.cookieName} cookie 可换取连接凭据`
      + `（代铸有效期 ${String(settings.cookieMaxAgeSec)}s，登录页 ${settings.loginPage ? LOGIN_PATH : '关闭'}）`,
    )
  },
}

/* ===========================================================================
 * 组件二：模型 Key（原 `model-key.mjs`）
 *
 * 把本产品为**当前登录用户**签发的网关 Key 送进凭据层。
 *
 * 官方 harness 的模型调用有两条路，都不通本产品：
 *
 * | route | 包 | 发的头 | 为什么不行 |
 * |-------|----|--------|-----------|
 * | `deepseek-official` | `llm-deepseek-api-key` | `x-api-key` | 头对了，但没有 Key |
 * | `deepseek-account` | `llm-deepseek-account` | `x-dsh-auth-token` | 网关**不读这个头**（实测 401） |
 *
 * 本产品的 server 早就把 Key 准备好了（`GET /api/account/model-access` 回
 * `access.apiKey`），只是**没有任何东西去取它**。本组件补上那一步：登录后取一次，
 * 写进凭据层的 `refs:`，让 `llm-pi-ai`（`platform/cordis.patch.yml` 里那个
 * `dsharness-relay` profile）的 `apiKeyEnv: DSHARNESS_MODEL_KEY` 能解析到真值；
 * 退登时删掉。这就是「登录之后获取的 key 有问题」的那一步。
 * ======================================================================== */

/**
 * 凭据引用名。
 *
 * 与 `platform/cordis.patch.yml` 里 `llm-pi-ai.providers.dsharness-relay.apiKeyEnv`
 * **必须一致** —— 改名要同时改两处，否则模型调用会以 `MISSING_CREDENTIAL` 失败。
 * 大写加下划线是凭据引用的合法形状（`credentials/src/index.ts:19`）。
 */
export const MODEL_KEY_REF = 'DSHARNESS_MODEL_KEY'

/** 本产品取 Key 的端点（挂在 server 的 `/api/account/` 之下）。 */
export const MODEL_ACCESS_PATH = '/api/account/model-access'

/**
 * 失败后的重试间隔序列（毫秒）。
 *
 * 取 Key 失败**不该**让应用不可用：模型调用会以 `MISSING_CREDENTIAL` 报出来，
 * 用户重开一次或等下次重试即可。所以退避重试而不是抛错。
 */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000, 300_000]

/** 请求超时。网关在另一个进程，挂住时必须自己收口，否则插件永远不落 Key。 */
export const REQUEST_TIMEOUT_MS = 15_000

/**
 * 从一次 `model-access` 响应里取出该用户的明文 Key。
 *
 * 成功包络是 `{ ok: true, access: { apiKey, apiKeyReason, keyState } }`；
 * `apiKey` 为 `null` 是**合法状态**（网关还没发出来 / 发失败），此时把
 * `apiKeyReason` 当原因回传。
 *
 * @param payload - 已解析的 JSON。
 * @returns 明文 Key 或失败原因；两者都不在时说明响应形状不认识。
 */
export function readModelKey(payload) {
  if (payload === null || typeof payload !== 'object') return { status: 'malformed' }
  const access = payload.access
  if (access === null || typeof access !== 'object') return { status: 'malformed' }
  const key = typeof access.apiKey === 'string' ? access.apiKey.trim() : ''
  if (key.length > 0) return { status: 'key', apiKey: key }
  const reason = typeof access.apiKeyReason === 'string' && access.apiKeyReason.trim() !== ''
    ? access.apiKeyReason.trim()
    : '产品服务端未下发 apiKey'
  return { status: 'unavailable', reason }
}

/**
 * 用会话 token 取一次该用户的 Key。
 *
 * @param origin - 本产品 server 的 origin（来自 account session）。
 * @param token - 本地会话 JWT（就是 `auth_exchange` 回的 token）。
 * @param options - `requestTimeoutMs`/`fetch`（测试注入）。
 * @returns `{status:'key'|'unavailable'|'unauthorized'|'malformed'|'unreachable', …}`。
 */
export async function fetchModelKey(origin, token, options = {}) {
  const url = `${String(origin).replace(/\/+$/, '')}${MODEL_ACCESS_PATH}`
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    'user-agent': USER_AGENT,
  }
  const doFetch = options.fetch ?? fetch
  let response
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(
        Number(options.requestTimeoutMs) > 0 ? Number(options.requestTimeoutMs) : REQUEST_TIMEOUT_MS,
      ),
    })
  } catch (error) {
    return { status: 'unreachable', reason: error instanceof Error ? error.message : String(error) }
  }
  if (response.status === 401 || response.status === 403) {
    // 会话失效：与「网络不通」区分开，调用方据此清掉旧 Key。
    return { status: 'unauthorized', reason: `HTTP ${String(response.status)}` }
  }
  if (!response.ok) return { status: 'unreachable', reason: `HTTP ${String(response.status)}` }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    return { status: 'malformed', reason: error instanceof Error ? error.message : String(error) }
  }
  return readModelKey(payload)
}

/**
 * 解析模型 Key 组件配置。
 *
 * `enabled: false` 可用于在本机临时关掉整条投递。
 *
 * @param config - 普通对象配置；无 schema。
 * @returns 归一后的设置。
 */
export function resolveModelKeyConfig(config = {}) {
  const raw = config ?? {}
  const ref = String(raw.ref ?? MODEL_KEY_REF).trim() || MODEL_KEY_REF
  return {
    enabled: raw.enabled !== false,
    ref,
    originOverride: raw.origin === undefined ? undefined : String(raw.origin).replace(/\/+$/, ''),
    requestTimeoutMs:
      Number.isFinite(Number(raw.requestTimeoutMs)) && Number(raw.requestTimeoutMs) > 0
        ? Math.floor(Number(raw.requestTimeoutMs))
        : REQUEST_TIMEOUT_MS,
  }
}

/** 模型 Key 组件：登录后投递，退登后清除。 */
export const modelKeyComponent = {
  name: 'dsharness/model-key',
  /*
   * 依赖两个服务，都不是可选的：
   * - `deepseekAccount` 提供 `getPlatformSession()`（拿到本产品的 origin 与会话 token）；
   * - `credentials` 是**唯一**能写凭据层的服务。
   */
  inject: ['deepseekAccount', 'credentials'],
  apply(ctx, config) {
    const settings = resolveModelKeyConfig(config)
    if (!settings.enabled) {
      ctx.logger.warn(`[${name}/model-key] 已关闭（enabled: false）：模型 Key 不会自动投递`)
      return
    }

    const account = ctx.deepseekAccount
    const credentials = ctx.credentials

    /** 当前已写入凭据层的值，用来避免每次 watch 重跑都写一遍同一个 Key。 */
    let written

    async function store(apiKey) {
      if (written === apiKey) return
      await credentials.set(settings.ref, apiKey)
      written = apiKey
      ctx.logger.info(`[${name}/model-key] 已写入 ${settings.ref}（sk-…${apiKey.slice(-4)}）`)
    }

    async function clear(reason) {
      if (written === undefined) {
        // 也可能是上一次进程留下的：只有在确实存在时才删，避免无谓的文件改写。
        const existing = await credentials.describe(settings.ref).catch(() => undefined)
        if (existing === undefined || existing.configured !== true) return
      }
      await credentials.unset(settings.ref)
      written = undefined
      ctx.logger.info(`[${name}/model-key] 已清除 ${settings.ref}${reason === undefined ? '' : `（${reason}）`}`)
    }

    /** 一次完整的「按当前账户状态同步凭据」。 */
    async function sync() {
      const session = await account.getPlatformSession()
      if (session === null) {
        await clear('已退登')
        return
      }
      const origin = settings.originOverride ?? session.origin
      const result = await fetchModelKey(origin, session.token, { requestTimeoutMs: settings.requestTimeoutMs })
      if (result.status === 'key') {
        await store(result.apiKey)
        return
      }
      if (result.status === 'unauthorized') {
        // 会话被作废（退登 / tokenVersion 提升）：旧 Key 不再属于任何人，删掉。
        await clear(`会话失效 ${result.reason}`)
        return
      }
      // 其余都是暂时性失败：保留已写入的 Key（它可能仍然有效），只记一条。
      ctx.logger.warn(`[${name}/model-key] 取模型 Key 失败：${result.status} ${result.reason ?? ''}`.trim())
    }

    ctx.effect(() => {
      const lifetime = new AbortController()
      /** 退避重试：网络抖动时不能只等下一次账户状态变化。 */
      let failures = 0
      let timer

      const attempt = async () => {
        if (lifetime.signal.aborted) return
        try {
          await sync()
          failures = 0
        } catch (error) {
          failures += 1
          const delay = RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)]
          const reason = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`[${name}/model-key] 同步失败，${String(delay)}ms 后重试：${reason}`)
          timer = setTimeout(() => { void attempt() }, delay)
        }
      }

      const loop = (async () => {
        await attempt()
        for await (const _state of account.watch(lifetime.signal)) {
          if (lifetime.signal.aborted) break
          await attempt()
        }
      })().catch((error) => {
        if (!lifetime.signal.aborted) {
          ctx.logger.warn(`[${name}/model-key] 订阅失败：${error instanceof Error ? error.message : String(error)}`)
        }
      })

      return async () => {
        lifetime.abort()
        clearTimeout(timer)
        await loop
      }
    }, `${name}/model-key: model key delivery`)
  },
}

/* ===========================================================================
 * 组件三：检查更新（原 `update.mjs`）
 *
 * 「检查更新」只有**一个**组件了：这一轮之前它被拆成 `dsharness-update`
 * （Host 页告知）与 `dsharness-update-ui`（设置里那一行）两张卡，功能重复，
 * 用户看到的就是两个「检查更新」。现在版本查询在这一半，
 * `platform/dsharness-ui.js` 是它的浏览器面（`/dsharness/status.json` 里的
 * `version` 段 + 设置里那一行按钮直接调官方 `updates.open()`）。
 *
 * ## 为什么必须在 platform 层做
 *
 * 官方的更新通道在**未签名构建**下是死的，而且不是「配置问题」：
 *
 * - `apps/desktop/scripts/electron-builder-config.mjs:249` —— unsigned 时
 *   `publish: null`，electron-builder 于是**不写** `app-update.yml`
 *   （`app-builder-lib/out/publish/PublishManager.js:87-90` 只在
 *   `getAppUpdatePublishConfiguration()` 非 null 时才写）；
 * - `apps/desktop/src/update-coordinator.ts:54` 的 `enabled()` 要求
 *   `existsSync(join(process.resourcesPath, 'app-update.yml'))`，`:185` 直接抛
 *   `desktop update: this application has no packaged update source`。
 *
 * 上一轮已经实测推翻了「未签名就不能应用内更新」这个结论：唯一拦路的是
 * **feed 对象不存在**，而 feed 与 `app-update.yml` 由本产品的安装器自己投放
 * （见 `docs/architecture/desktop-updater-feed.md`）。所以这一半负责**版本来源**，
 * 下载与安装交给官方 electron-updater（`dshDesktop.updates.open()`）。
 *
 * ## 版本从哪来
 *
 * 产品 server 早就有 `GET /api/config/version`（`server/src/routes/api.ts:240`），
 * 回 `{ ok, release }`，而 `release` 就是管理端维护的发布信息。这里直接读它 ——
 * **不新增一套版本清单**。
 *
 * 当前安装版本从 `<DSH_HOME>/dsharness-install.json` 读：那是**安装期**由
 * `deploy-entry.mjs` 用 NSIS 的 `${VERSION}` 写下的。之所以不猜：未签名构建里
 * 只有安装器知道用户装的是哪个版本。
 * ======================================================================== */

/**
 * 本产品 server 的 origin。
 *
 * ⚠️ 必须与 `platform/build-deploy-payload.mjs` 的 `DEFAULT_PLATFORM_ORIGIN`
 * 一致 —— `dsharness.test.mjs` 会把两者比一遍。这里写字面量而不是 import，
 * 是因为装好的包只有 `index.mjs` 一个文件，import 不到兄弟模块。
 */
export const DEFAULT_ORIGIN = 'https://www.czmanong.com'

/** 版本清单端点（产品 server 已有，复用它的前缀路由，不必动网关）。 */
export const RELEASE_PATH = '/api/config/version'

/** 检查更新页与它的 JSON 面。 */
export const UPDATE_PATH = '/dsharness/update'
export const UPDATE_JSON_PATH = '/dsharness/update.json'

/** 安装期写下的版本记录（`deploy-entry.mjs` 用 NSIS 的 `${VERSION}` 写）。 */
export const INSTALL_RECORD = 'dsharness-install.json'

/**
 * 拆一个 semver 成可比较的数字段。
 *
 * 不引 semver 包（包目录里没有 `node_modules`）。够用的范围就是本产品用到的形态：
 * `0.2.1-alpha.1.20261007.2`。规则：数字段按数值比；**有预发布段的小于没有的**
 * （`1.0.0-rc < 1.0.0`），预发布段之间先按数字、再按字典序。
 *
 * @param value - 版本字符串。
 * @returns `{ release: string[], prerelease: string[] }`。
 */
export function splitVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '')
  const plus = text.indexOf('+')
  const core = plus < 0 ? text : text.slice(0, plus)
  const dash = core.indexOf('-')
  const release = (dash < 0 ? core : core.slice(0, dash)).split('.')
  const prerelease = dash < 0 ? [] : core.slice(dash + 1).split('.')
  return { release, prerelease }
}

/**
 * 比较两个版本。
 *
 * @param a - 左版本。
 * @param b - 右版本。
 * @returns `-1` / `0` / `1`。
 */
export function compareVersions(a, b) {
  const left = splitVersion(a)
  const right = splitVersion(b)
  const length = Math.max(left.release.length, right.release.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (Number(left.release[index]) || 0) - (Number(right.release[index]) || 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  // 有预发布段的一侧**更小**：0.2.1-alpha < 0.2.1
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < prereleaseLength; index += 1) {
    const one = left.prerelease[index]
    const other = right.prerelease[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue
    const numeric = Number(one) - Number(other)
    if (Number.isFinite(numeric) && numeric !== 0) return numeric < 0 ? -1 : 1
    return one < other ? -1 : 1
  }
  return 0
}

/**
 * 取安装期写下的版本记录。
 *
 * 任何一步失败都回 `undefined`：读不到只说明「不知道当前版本」，
 * 页面照常显示最新版本与下载链接，不该整面报错。
 *
 * @param home - Harness home。
 * @returns `{ version, installDir?, installedAt? }` 或 undefined。
 */
export function readInstallRecord(home) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, INSTALL_RECORD), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const version = typeof parsed.version === 'string' ? parsed.version.trim() : ''
    if (version === '') return undefined
    return {
      version,
      ...typeof parsed.installDir === 'string' ? { installDir: parsed.installDir } : {},
      ...typeof parsed.installedAt === 'string' ? { installedAt: parsed.installedAt } : {},
    }
  } catch {
    return undefined
  }
}

/**
 * 从 `/api/config/version` 的响应里取出发布信息。
 *
 * `release: null` 是**合法状态**（出厂就是「还没发布过」），不是错误。
 *
 * @param payload - 已解析的 JSON。
 * @returns 归一后的发布信息，或 undefined（未发布 / 形状不认识）。
 */
export function pickRelease(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const release = payload.release
  if (release === null || release === undefined || typeof release !== 'object') return undefined
  const version = typeof release.version === 'string' ? release.version.trim() : ''
  if (version === '') return undefined
  return {
    version,
    ...typeof release.winUrl === 'string' && release.winUrl !== '' ? { downloadUrl: release.winUrl } : {},
    ...typeof release.notes === 'string' && release.notes !== '' ? { notes: release.notes } : {},
    ...typeof release.publishedAt === 'string' && release.publishedAt !== '' ? { publishedAt: release.publishedAt } : {},
  }
}

/**
 * 查一次更新。
 *
 * @param options - `origin` / `home` / `requestTimeoutMs` / `fetch`（测试注入）。
 * @returns 一个**永远 resolve** 的结果对象；拿不到清单时 `ok: false` 并给出原因。
 */
export async function checkForUpdate(options = {}) {
  const origin = String(options.origin ?? DEFAULT_ORIGIN).replace(/\/+$/, '')
  const home = String(options.home ?? '')
  const requestTimeoutMs = Number(options.requestTimeoutMs) > 0 ? Number(options.requestTimeoutMs) : REQUEST_TIMEOUT_MS
  const doFetch = options.fetch ?? fetch
  const record = home === '' ? undefined : readInstallRecord(home)
  const current = record?.version ?? null
  const checkedAt = new Date().toISOString()
  let response
  try {
    response = await doFetch(`${origin}${RELEASE_PATH}`, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
  } catch (error) {
    return { ok: false, current, checkedAt, reason: 'unreachable', message: error instanceof Error ? error.message : String(error) }
  }
  if (!response.ok) {
    return { ok: false, current, checkedAt, reason: 'unreachable', message: `HTTP ${String(response.status)}` }
  }
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    return { ok: false, current, checkedAt, reason: 'malformed', message: error instanceof Error ? error.message : String(error) }
  }
  const release = pickRelease(payload)
  if (release === undefined) {
    // 出厂/未发布：合法状态，不是失败。
    return { ok: true, current, checkedAt, latest: null, updateAvailable: false, source: `${origin}${RELEASE_PATH}` }
  }
  const updateAvailable = current !== null && compareVersions(release.version, current) > 0
  return {
    ok: true,
    current,
    latest: release.version,
    updateAvailable,
    ...release.downloadUrl === undefined ? {} : { downloadUrl: release.downloadUrl },
    ...release.notes === undefined ? {} : { notes: release.notes },
    ...release.publishedAt === undefined ? {} : { publishedAt: release.publishedAt },
    source: `${origin}${RELEASE_PATH}`,
    checkedAt,
  }
}

/**
 * 检查更新页。
 *
 * 每次打开都现查一次（页面里也有「重新检查」按钮）：这一面读的是远端清单，
 * 缓存它只会让用户看到过期结论。
 *
 * @param result - {@link checkForUpdate} 的结果。
 * @returns 页面 HTML。
 */
export function updatePageHtml(result) {
  const line = (label, value) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`
  const rows = [line('当前版本', result.current === null ? '<code>未知</code>' : `<code>${escapeHtml(result.current)}</code>`)]
  if (result.ok) {
    rows.push(line('最新版本', result.latest === null ? '<code>尚未发布</code>' : `<code>${escapeHtml(result.latest)}</code>`))
    rows.push(line('检查结果', result.updateAvailable ? '<strong>有新版本</strong>' : '已是最新'))
    if (result.downloadUrl !== undefined) {
      rows.push(line('下载', `<a href="${escapeHtml(result.downloadUrl)}" rel="noreferrer">${escapeHtml(result.latest ?? '安装包')}</a>`))
    }
  } else {
    rows.push(line('检查结果', `<span class="bad">暂时查不到（${escapeHtml(result.reason ?? 'unknown')}）</span>`))
    rows.push(line('原因', escapeHtml(result.message ?? '')))
  }
  if (result.publishedAt !== undefined) rows.push(line('发布时间', escapeHtml(result.publishedAt)))
  if (result.current === null) {
    rows.push(line('说明', '这个 home 里没有安装记录，所以无法比较版本；下面的下载链接仍然可用。'))
  }
  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    '<title>DSH Desktop 检查更新</title>',
    '<style>',
    ':root{color-scheme:light dark}body{font:14px/1.7 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh}',
    'main{width:min(720px,94vw);padding:24px;border:1px solid #8883;border-radius:12px}',
    'h1{font-size:16px;margin:0 0 4px}p.lead{color:#6b7280;font-size:12px;margin:0 0 16px}',
    'table{border-collapse:collapse;width:100%}th{text-align:left;font-weight:400;color:#6b7280;width:9em;padding:6px 8px 6px 0;vertical-align:top}',
    'td{padding:6px 0;word-break:break-all}code,a{font-family:ui-monospace,monospace}',
    '.bad{color:#b45309}pre{white-space:pre-wrap;font:inherit;color:#6b7280;font-size:12px;margin:12px 0 0}',
    '</style></head><body><main>',
    '<h1>检查更新</h1>',
    '<p class="lead">本产品的版本清单由产品服务端下发。桌面端可在「设置 › 通用」里点「检查更新」下载并安装；这一页给浏览器里的自己用。</p>',
    '<table>',
    ...rows,
    '</table>',
    result.notes === undefined ? '' : `<pre>${escapeHtml(result.notes)}</pre>`,
    '<p><a href="">重新检查</a> · <a href="/dsharness/gateway.json">网关信息</a></p>',
    '</main></body></html>',
    '',
  ].join('\n')
}

/**
 * 解析检查更新组件配置；`enabled: false` 可整面关掉。
 *
 * @param config - 普通对象配置；无 schema。
 * @returns 归一后的设置。
 */
export function resolveUpdateConfig(config = {}) {
  const raw = config ?? {}
  return {
    enabled: raw.enabled !== false,
    origin: String(raw.origin ?? process.env.DSH_PLATFORM_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, ''),
    home: String(raw.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')),
    requestTimeoutMs: Number.isFinite(Number(raw.requestTimeoutMs)) && Number(raw.requestTimeoutMs) > 0
      ? Math.floor(Number(raw.requestTimeoutMs))
      : REQUEST_TIMEOUT_MS,
  }
}

/**
 * 检查更新组件：两条只读 HTTP 路由（页面 + JSON）。
 *
 * ⚠️ 为什么不需要像网关那样放行 `authorizeIndex`：`webServer` 的 `match()` 是
 * **先查 exact 表**再走前缀兜底（`packages/host/webserver/src/index.ts:319-328`），
 * 所以 `kind: 'exact'` 的路由根本不会落到 `frontend-static` 的 index 处理上。
 */
export const updateComponent = {
  name: 'dsharness/update',
  inject: ['webServer'],
  apply(ctx, config) {
    const settings = resolveUpdateConfig(config)
    if (!settings.enabled) {
      ctx.logger.warn(`[${name}/update] 已关闭（enabled: false）：不提供检查更新`)
      return
    }

    /** 每次请求现查；一次请求内只查一次。 */
    const check = () => checkForUpdate({
      origin: settings.origin,
      home: settings.home,
      requestTimeoutMs: settings.requestTimeoutMs,
    })

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: UPDATE_JSON_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, message: '只支持 GET' })
          return
        }
        try {
          sendJson(res, 200, await check())
        } catch (error) {
          sendJson(res, 200, { ok: false, reason: 'unexpected', message: error instanceof Error ? error.message : String(error), current: null })
        }
      },
    }), `${name}/update: ${UPDATE_JSON_PATH}`)

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: UPDATE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, message: '只支持 GET' })
          return
        }
        let result
        try {
          result = await check()
        } catch (error) {
          result = { ok: false, current: null, reason: 'unexpected', message: error instanceof Error ? error.message : String(error) }
        }
        const html = updatePageHtml(result)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': String(Buffer.byteLength(html)),
        })
        res.end(req.method === 'HEAD' ? undefined : html)
      },
    }), `${name}/update: ${UPDATE_PATH}`)

    const record = readInstallRecord(settings.home)
    ctx.logger.info(
      `[${name}/update] 已启用：${UPDATE_PATH} 显示 ${record === undefined ? '（本 home 无安装记录）' : record.version}`
      + `，清单 ${settings.origin}${RELEASE_PATH}`,
    )
  },
}

/* ===========================================================================
 * 组装：一行 = 三个子插件（第四个「组件」是网关那半边里的状态面板）
 * ======================================================================== */

/**
 * 挂载这个插件。
 *
 * 三个组件各自用 `ctx.plugin({ name, inject, apply })` 挂成**子插件**：Cordis
 * 原生支持一行挂一棵插件树，每个子插件有自己的 `inject`（服务没就绪时那个组件
 * 等，别的组件照常跑），dispose 时整棵树一起收。
 *
 * 配置按组件分段（由 `platform/provision.mjs` 生成的行里给出）：
 *
 * ```yaml
 * config:
 *   gateway:   { token: !!js …, cookieName: dsharness_auth, loginPage: true }
 *   modelKey:  { ref: DSHARNESS_MODEL_KEY }
 *   update:    { origin: '' }
 * ```
 *
 * 缺段就是各组件自己的默认值，所以任何一段都可以不写。
 *
 * @param ctx - Cordis 上下文。
 * @param config - `{ gateway?, modelKey?, update? }`；无 schema。
 */
export function apply(ctx, config) {
  const raw = config ?? {}
  ctx.plugin(gatewayComponent, raw.gateway)
  ctx.plugin(modelKeyComponent, raw.modelKey)
  ctx.plugin(updateComponent, raw.update)
  ctx.logger.info(
    `[${name}] 已挂载：本机网关 + 模型 Key + 检查更新 + 状态面板`
    + '（本插件由本产品随安装包投放，插件页不可关闭）',
  )
}
