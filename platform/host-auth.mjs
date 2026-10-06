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

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

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
 * 解析配置：`config.token` 优先，其次环境变量；非法即视为未配置。
 *
 * 「键不存在」与「键存在但为空」是两件事，刻意区分开。部署行的 YAML 是
 * `!!js process.env.DSH_AUTH_TOKEN ?? ''`，所以正常情况下环境变量已经被那一行
 * 读过了；这里再读一次只是为了让直接构造配置的调用方（测试、别的合成层）
 * 也能用同一个入口。显式写 `token: ''` 就是「不要这个通道」，不该被环境变量
 * 顶回来 —— 否则「在本机关掉它」这件事在配了环境变量的机器上做不到。
 */
export function resolveConfig(config = {}) {
  const raw = config ?? {}
  const declared = Object.hasOwn(raw, 'token') ? raw.token : process.env.DSH_AUTH_TOKEN
  const token = String(declared ?? '').trim()
  const enabled = raw.enabled !== false && token.length >= MIN_TOKEN_LENGTH
  return {
    enabled,
    token,
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
    return originalAuthorizeIndex.call(this, request, response)
  }
  connection.authorizeIndex = wrappedAuthorizeIndex

  ctx.effect(() => () => {
    if (connection.requestRejection === wrappedRejection) connection.requestRejection = originalRejection
    if (connection.authorizeIndex === wrappedAuthorizeIndex) connection.authorizeIndex = originalAuthorizeIndex
  }, `${name}: connection credential equivalence`)

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
