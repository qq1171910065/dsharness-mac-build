/**
 * dsharness-host-auth — 让**服务端到服务端**的调用方用一个共享密钥就能打 DSH 的 `/api`。
 *
 * ## 为什么需要它
 *
 * 官方 harness 的 `/api` 有一道认证：`dsh-client-connection` 对每个请求跑
 * `isTrustedApiRequest`（Host/Origin 围栏）再跑 `BrowserAuth.isAuthenticated`，
 * 而后者**只认它自己签发的 `dsh-auth-<hash(authority)>` cookie**
 * （HMAC-SHA256、与 Host 绑定、有有效期）。那个 cookie 由 `dsh web` 启动时
 * 打印的 `?token=` 在 `GET /` 上换得，是**进程内私有**的。
 *
 * 于是「小程序 / 外部产品 / 脚本」这类**没有人坐在浏览器前**的调用方进不来：
 * 它拿不到那个 token，也不该为此去跑一个浏览器。
 *
 * 本插件给 `/api` 增加一条**等价的凭据**：正确的共享密钥
 * （`Authorization: Bearer <密钥>`，或本插件自己发的 cookie）会被换算成
 * 一次性的连接 cookie，追加到本次请求上，再由官方原有的认证逻辑放行。
 *
 * ## 这不是「第二套鉴权」，是同一套鉴权的另一种入口
 *
 * 它**不放宽**任何东西，也**不新增信任主体**：
 *
 * - 官方那两层（Host/Origin 围栏 + 连接 cookie 校验）**照常执行**；
 *   本插件只是在请求上补一个它认得的 cookie。围栏拒绝的请求依然被拒
 *   （非回环且不在 `trustedHosts` 里的 Host 拿不到入场券）。
 * - 未配置密钥、或密钥短于 16 位时，插件**什么都不做**（`/api` 回到
 *   官方默认行为），只记一条 warn。
 * - 密钥比较用 `timingSafeEqual`，长度不同也不提前返回。
 *
 * ## 为什么是「包装服务方法」而不是「注册一条路由」
 *
 * `webServer.register` 对同一个 (kind, path) **重复注册会抛错**，`/api`
 * 已经被 `dsh-client-connection` 占了；而升级握手 `/api/remote.mux` 又由
 * `api-gateway` 单独注册。两处放行判断最终都汇到 `connection` 服务的
 * `requestRejection` / `authorizeIndex` 上，所以**一处包装同时覆盖**：
 *
 * | 通道 | 谁调用 | 被包装后放行的入口 |
 * |------|--------|-------------------|
 * | `/api/*`（unary RPC） | `connection` 与 `api-gateway` | `requestRejection` |
 * | `/api/remote.mux`（WebSocket） | `api-gateway` 的 upgrade | `requestRejection` |
 * | `GET /`（页面本身） | web-app 的 dist server | `authorizeIndex` |
 *
 * ## 为什么是零依赖的 `.mjs`
 *
 * 这个文件由 `platform/provision.mjs` 装成**真正的组合包**挂载
 * （`<profile>/node_modules/dsharness-host-auth/`，见那里的说明）——
 * 包目录里**没有** `node_modules`，解析不到
 * `@deepseek-ai/schemastery` / `@deepseek-ai/dsh-credentials` 这些裸包名。
 * 所以本文件只 import `node:` 内置模块：
 *
 * - 配置不用 schemastery，直接读普通对象（Cordis 允许无 schema 的配置）；
 * - 连接凭据的键 `client-connection/browser-session` 直接写字面量
 *   （`credentialKey(scope, id)` 的产物就是这个字符串的 brand，
 *   见 `packages/credentials/credentials/src/index.ts:69-76`）。
 *
 * ## 与上游的关系
 *
 * **上游一行未改。** 本文件在上游不存在的 `platform/` 目录里，
 * `git merge upstream/master` 不会碰到它。若上游将来把 token 模式做进
 * `dsh-client-connection` 本身（在 `requestRejection` 里直接接受共享密钥），
 * 这个插件就该**整体退休**，而不是继续叠垫片。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 稳定插件名（Cordis 用它做 fiber 标识与 dispose 归属）。 */
export const name = 'dsharness-host-auth'

/**
 * 等 `connection` 挂载后再包装它。
 *
 * `credentials` **刻意不写在这里**，而是在 `apply` 里用 `ctx.get('credentials')` 取：
 * 拿不到签名密钥时应当退化成「不代铸 cookie（记一条 warn）」，
 * 而不是「插件挂不上、整条通道消失」。这与上游 `client-connection` 自己的
 * 取舍一致（见 `deepseek-account-platform` 的同类注释）。
 */
export const inject = ['connection']

/** 密钥最短长度；与官方连接 cookie 的强度对齐。 */
export const MIN_TOKEN_LENGTH = 16

/** 连接 cookie 的前缀（`dsh-auth-<base64url(sha256(authority))>`）。 */
export const CONNECTION_COOKIE_PREFIX = 'dsh-auth-'

/** 本插件给浏览器发的 cookie 名。 */
export const DEFAULT_COOKIE = 'dsharness_auth'

/** 本插件自己的登录页路径（避开 SPA fallback）。 */
export const LOGIN_PATH = '/dsharness/auth'

/**
 * 「网关信息」页路径 —— 把**本机监听端口**与**共享密钥**显示给运行 DSH 的人。
 *
 * 为什么需要这一页：插件装好之后，「打哪个端口、带什么密钥」只存在于进程内存里。
 * `dsh web` 只在**启动那一次**把 `?token=` 打到终端，而桌面端连终端都没有 ——
 * 于是外部调用方（小程序、脚本、另一个服务）根本不知道往哪打、带什么，
 * 也就是「无法对接」。上游没有这个面，而本插件本来就是「给没有浏览器的人开一条
 * 入口」，所以由它自己渲染这一页，而不是去改官方设置页（那要动上游源码）。
 */
/**
 * 网关信息页路径 —— 把**本机监听端口**与**共享密钥**显示给运行 DSH 的人。
 *
 * 为什么需要这一页：插件装好之后，「打哪个端口、带什么密钥」只存在于进程内存里。
 * `dsh web` 只在**启动那一次**把 `?token=` 打到终端，而桌面端连终端都没有 ——
 * 于是外部调用方（小程序、脚本、另一个服务）根本不知道往哪打、带什么，
 * 也就是「无法对接」。上游没有这个面，而本插件本来就是「给没有浏览器的人开一条
 * 入口」，所以由它自己渲染这一页，而不是去改官方设置页（那要动上游源码）。
 */
export const STATUS_PATH = '/dsharness/gateway'

/**
 * 同一份信息的 JSON 版本。
 *
 * 为什么同时要一个 JSON 面：这一页是要被人（和别的程序）读的。给 HTML 加一层
 * 抓取是脆的；`<STATUS_PATH>.json` 让调用方与验收脚本拿同一份事实，而不必解析页面。
 * 它同样只在回环上回。
 */
export const STATUS_JSON_PATH = '/dsharness/gateway.json'

/**
 * 公开路径：即使连接层拒了请求，也必须能读到的那几条。
 *
 * `frontend-static` 把 `/` 交给 `ctx.connection.authorizeIndex`，**先拒绝就
 * 直接结束响应** —— 也就是说「所有路由都进不去了」。而 `authorizeIndex` 只
 * 放行 `GET /`（带 cookie / 带启动 token）。所以本插件自己的两条路径必须在这里
 * 放行，否则它们的可读性取决于**路由注册顺序**：`http` 面先命中就直接响应，
 * 先被拒就永远到不了 handler。实测这一顺序不是我们能定的，所以显式放行。
 *
 * `GET` 之外的方法**不放行**（登录页的 POST 不需要：它本来就只在浏览器里用，
 * 而浏览器打开首页会先换到连接 cookie）。
 */
export const PUBLIC_PATHS = [LOGIN_PATH, STATUS_PATH, STATUS_JSON_PATH]

/**
 * 自动生成并持久化密钥时用的凭据引用名。
 *
 * ⚠️ 这里写的是**字面量**而不是 `credentialRef('DSHARNESS_AUTH_TOKEN')`：
 * 本文件零依赖（包目录里没有 `node_modules`），import 不到
 * `@deepseek-ai/dsh-credentials`。而 `credentialRef` 只是**校验并打 brand**，
 * 运行时值就是这个字符串本身 —— 与 `ensureSecret` 里直接写
 * `'client-connection/browser-session'` 是同一个理由。
 */
export const TOKEN_REF = 'DSHARNESS_AUTH_TOKEN'

/** 自动生成密钥的字节数（base64url 之后 43 字符，远高于 {@link MIN_TOKEN_LENGTH}）。 */
export const GENERATED_TOKEN_BYTES = 32

/**
 * 代铸 cookie 的有效期。
 *
 * **故意很短**：cookie 每次请求现铸，只需要活过这一次请求。取短值还顺带
 * 绕开一个坑 —— 官方连接层会拒绝 `expiresAt - issuedAt` 超过它自己
 * `cookieMaxAgeDays`（默认 30 天）的 cookie；1 小时在任何合法配置下都安全，
 * 而照抄 30 天会在运营把 `cookieMaxAgeDays` 调小时失效。
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

/** 取一条请求携带的**共享密钥**：先看 `Authorization: Bearer`，再看本插件自己的 cookie。 */
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
 * 格式必须与 `packages/client/connection/src/browser-auth.ts` 的
 * `encodeCookie` 逐字节一致：`v1.<base64url(json)>.<base64url(hmacSha256(body))>`，
 * json 是 `{version:1, authority, issuedAt, expiresAt}`。
 * 格式漂移由 `apply` 的自检（`verifyMinting`）当场发现。
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
 * 解析配置：`config.token` 优先，其次环境变量，都没有（或太短）就**生成一把**。
 *
 * ## 为什么没有配置也要生成一把（而不是像以前那样整体不启用）
 *
 * 用户口径：「网关插件要能显示端口和令牌，否则我无法对接」——**显示**的前提是
 * 真的有一把令牌。此前 `token: ''` ⇒ `enabled: false` ⇒ 插件根本不挂载，
 * 于是既没有通道、也没有任何可显示的东西，对接方拿不到任何东西。
 * 现在未配置时生成一把随机值，由 `apply` 写进凭据层（{@link TOKEN_REF}），
 * 下次启动由部署行读回来，所以它在进程之间是**稳定**的。
 *
 * ## 「关掉这条通道」只认 `enabled: false`
 *
 * 部署行是 `token: !!js process.env.DSH_AUTH_TOKEN ?? ''`，也就是**总是**给出
 * `token` 键（没配环境变量时是空串）。所以「显式空串＝关掉它」这条老口径已经
 * 表达不了意图：空串必须按「未配置」处理，否则默认就永远是关的。
 * 唯一的开关是 `enabled: false`。
 *
 * ## 太短的声明值会被换掉，但必须可诊断
 *
 * 太短的密钥此前就等于整条通道不工作，所以没有调用方依赖它；换一把强的不会破坏谁。
 * 但「我明明配了却没用」是必须能在日志里看出来的，所以 `rejectedDeclared` 单独标出。
 *
 * @param config - 插件配置；无 schema。
 * @param generate - 生成器，测试可注入。
 * @returns 归一后的设置。
 */
export function resolveConfig(config = {}, generate = generateToken) {
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
    /**
     * 声明过密钥但短于下限，因此被换掉。
     *
     * 与 `generated` 分开：空串是「没配」（正常默认），而「配了但太短」是配置错误，
     * 值得一条 warn，否则用户会以为自己的配置生效了。
     */
    rejectedDeclared: !usable && configured.length > 0,
    cookieName: String(raw.cookieName ?? DEFAULT_COOKIE).trim() || DEFAULT_COOKIE,
    cookieMaxAgeSec: Number.isFinite(Number(raw.cookieMaxAgeSec)) && Number(raw.cookieMaxAgeSec) > 0
      ? Math.floor(Number(raw.cookieMaxAgeSec))
      : DEFAULT_MINT_MAX_AGE_SEC,
    loginPage: raw.loginPage !== false,
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
 * 读取请求体（限长，避免把内存交给陌生人）。 */
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

/** JSON 响应（不缓存：这一面显示的是密钥）。 */
export function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

/**
 * HTML 转义。
 *
 * 这里只是把**密钥**放进页面 —— 它是 base64url，本来就只含 `[A-Za-z0-9_-]`。
 * 仍然转义，是因为这一面将来可能显示别的可配置字符串，而「先把值拼进 HTML
 * 再说」正是这类页面出问题的方式。
 *
 * @param value - 要放进 HTML 文本节点的值。
 * @returns 转义后的字符串。
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
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
 * - **不带 `?token=`**。`dsh web` 的启动 URL 里那个 token 是**连接层**的
 *   一次性凭据（本插件拿不到也不需要），与本插件的共享密钥是两回事；
 *   把两者混在一个 URL 里会让「哪个是哪个」永远说不清。
 *
 * @param settings - 已解析的插件配置。
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
      ? [['来源', '<code>本次自动生成，已写入本机凭据（DSHARNESS_AUTH_TOKEN）</code>']]
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

/**
 * 挂载。
 *
 * ⚠️ **在一个长寿命进程里打开再关掉这个插件时，「关掉」并不完全生效。**
 *
 * 实测（真机桌面 Host，经官方 `setBundleEnabled` 打开再关闭）：
 * `listBundles` 回 `enabled: false`、`pluginInventory/list` 里已经没有这一行，
 * 但**带正确密钥的 `/api` 仍然 200**（不给密钥照旧 401，所以不是恒真）。
 * 也就是说 `ctx.effect` 的清理**恢复了 `connection` 上的方法引用**，
 * 而**已经换取过的连接 cookie 仍被官方那两层认作有效** ——
 * 它本来就是一个短时凭证，官方并不在每次请求上复查「它是谁铸的」。
 *
 * 这不是本插件能修的（要作废已发凭证就得动官方 `connection`），
 * 也不影响默认态：默认**没打开过**，就从来没有过 cookie。
 * 真要立刻作废，把密钥换掉（`DSH_AUTH_TOKEN`）并重启 —— cookie 是用
 * 连接层密钥签的，换密钥即全量失效。
 *
 * @param ctx - Cordis 上下文（`connection` 已通过 `inject` 就绪）。
 * @param config - `{ enabled, token, cookieName, cookieMaxAgeSec, loginPage }`；无 schema。
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  if (!settings.enabled) {
    ctx.logger.warn(
      `[${name}] 未启用：需要 ≥${MIN_TOKEN_LENGTH} 位的共享密钥`
      + `（配置项 token，或环境变量 DSH_AUTH_TOKEN）。/api 保持官方默认行为。`,
    )
    return
  }

  const connection = ctx.connection
  /** 连接层签名密钥；首次用到时异步读入并缓存（`requestRejection` 是同步的）。 */
  let secret
  let loading

  const credentials = ctx.get('credentials')

  /**
   * 把自动生成的密钥持久化，让它在进程之间稳定。
   *
   * 为什么必须持久化：页面显示的那把密钥就是对接方要长期使用的那把。若每次启动
   * 都重新生成，用户抄下来的那一把下次启动就失效 —— 这不是「显示令牌」，
   * 而是「显示一个正在过期的令牌」。写进凭据层（`refs:`）之后，部署行的
   * `!!js process.env.DSH_AUTH_TOKEN ?? ''` 之外还有第二处稳定来源。
   *
   * 失败只记一条：读不到凭据层时插件仍然可用（本次进程内密钥有效），
   * 不该因为「存不下」就让整条通道消失。
   */
  if (settings.generated && credentials !== undefined) {
    if (settings.rejectedDeclared) {
      ctx.logger.warn(
        `[${name}] 配置的密钥短于 ${MIN_TOKEN_LENGTH} 位，已换成本次生成的随机值`
        + `（这条通道此前会整体不启用；改配置项 token 或 DSH_AUTH_TOKEN）`,
      )
    }
    void Promise.resolve()
      .then(() => credentials.set(TOKEN_REF, settings.token))
      .then(() => {
        ctx.logger.info(`[${name}] 已生成并保存共享密钥（${TOKEN_REF}），可在 ${STATUS_PATH} 查看`)
      })
      .catch((error) => {
        ctx.logger.warn(
          `[${name}] 未能保存生成的密钥（${error instanceof Error ? error.message : String(error)}）；`
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
          ctx.logger.warn(`[${name}] 连接凭据格式不认识，暂不代铸 cookie`)
          return
        }
        secret = decoded
      })
      .catch((error) => {
        ctx.logger.warn(`[${name}] 读取连接凭据失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => { loading = undefined })
  }

  ensureSecret()

  /**
   * 请求带了正确密钥就把连接 cookie 补上。
   * @returns 是否补过（用于诊断与登录页）。
   */
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

  /**
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
          `[${name}] 连接 cookie 格式可能与上游漂移（自检得到 ${String(rejection)}），`
          + '小程序 / 脚本通道可能失效，请对照 packages/client/connection/src/browser-auth.ts',
        )
      }
    } catch (error) {
      ctx.logger.warn(`[${name}] 自检失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const originalRejection = connection.requestRejection
  const wrappedRejection = function (request) {
    try { admit(request) } catch (error) {
      ctx.logger.warn(`[${name}] 代铸 cookie 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return originalRejection.call(this, request)
  }
  connection.requestRejection = wrappedRejection

  const originalAuthorizeIndex = connection.authorizeIndex
  const wrappedAuthorizeIndex = function (request, response) {
    // 浏览器带本插件 cookie 打开页面时，同样先换成连接 cookie，
    // 否则首页会 401（页面本身的认证不走 requestRejection）。
    try { admit(request) } catch (error) {
      ctx.logger.warn(`[${name}] 代铸 cookie 失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // 本插件自己的那两条路径永远放行（GET）：它们是「看得见的凭据」这一面，
    // 而 authorizeIndex 只认 `GET /`，先拒绝就直接结束响应了。
    const url = new URL(request.url ?? '/', 'http://dsh.invalid')
    if (request.method === 'GET' && PUBLIC_PATHS.includes(url.pathname)) return true
    return originalAuthorizeIndex.call(this, request, response)
  }
  connection.authorizeIndex = wrappedAuthorizeIndex

  ctx.effect(() => () => {
    if (connection.requestRejection === wrappedRejection) connection.requestRejection = originalRejection
    if (connection.authorizeIndex === wrappedAuthorizeIndex) connection.authorizeIndex = originalAuthorizeIndex
  }, `${name}: connection credential equivalence`)

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
      }), `${name}: ${LOGIN_PATH}`)

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
      }), `${name}: ${STATUS_PATH}`)

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
      }), `${name}: ${STATUS_JSON_PATH}`)
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
    `[${name}] 已启用：Bearer / ${settings.cookieName} cookie 可换取连接凭据`
    + `（代铸有效期 ${String(settings.cookieMaxAgeSec)}s，登录页 ${settings.loginPage ? LOGIN_PATH : '关闭'}）`,
  )
}
