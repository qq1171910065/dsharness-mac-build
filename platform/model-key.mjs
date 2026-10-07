/**
 * dsharness-model-key — 把本产品为**当前登录用户**签发的网关 Key 送进凭据层。
 *
 * ## 为什么需要它
 *
 * 官方 harness 的模型调用有两条路，都不通本产品：
 *
 * | route | 包 | 发的头 | 为什么不行 |
 * |-------|----|--------|-----------|
 * | `deepseek-official` | `llm-deepseek-api-key` | `x-api-key` | 头对了，但没有 Key |
 * | `deepseek-account` | `llm-deepseek-account` | `x-dsh-auth-token` | 网关**不读这个头**（实测 401） |
 *
 * 本产品的 server 早就把 Key 准备好了（`GET /api/account/model-access` 回
 * `access.apiKey`），只是**没有任何东西去取它**：实测在 `client/` 里搜
 * `model-access` / `apiKeyCreated` / `dshModelKey` 是 **0 处命中**。
 * 所以登录之后模型调用必然失败 —— 这就是「登录之后获取的 key 有问题」。
 *
 * 本文件补上那一步：登录后取一次，写进凭据层的 `refs:`，让
 * `llm-pi-ai`（`platform/cordis.patch.yml` 里那个 `dsharness-relay` profile）
 * 的 `apiKeyEnv: DSHARNESS_MODEL_KEY` 能解析到真值；退登时删掉。
 *
 * ## 为什么不去改官方 provider 的凭据来源
 *
 * `llm-deepseek-account.resolveAuth` 走 `account.resolveToken(baseURL)`，而后者
 * 要求 `new URL(baseURL).origin === inferenceOrigin`（默认 `https://api.deepseek.com`）。
 * 把 `inferenceOrigin` 指到网关也**没用** —— 它发的 `x-dsh-auth-token`
 * 网关不认（实测：同一个有效 key，`x-dsh-auth-token` 401、`x-api-key` 200）。
 * 所以正路是 API-key 型 route，而它要的是 `apiKeyEnv` 里的凭据，不是 account grant。
 *
 * ## 为什么零依赖
 *
 * 与 `host-auth.mjs` 同理由：本文件由 `platform/provision.mjs` 装成组合包，
 * 包目录里**没有** `node_modules`，解析不到任何裸包名。所以只用 `node:` 与全局
 * `fetch`，配置读普通对象（Cordis 允许无 schema 的配置）。
 *
 * ## 与上游的关系
 *
 * **上游一行未改。** 本文件在上游不存在的 `platform/` 目录里，
 * `git merge upstream/master` 不会碰到它。
 */

/** 稳定插件名（Cordis 用它做 fiber 标识与 dispose 归属）。 */
export const name = 'dsharness-model-key'

/**
 * 依赖两个服务，都不是可选的：
 * - `deepseekAccount` 提供 `getPlatformSession()`（拿到本产品的 origin 与会话 token）；
 * - `credentials` 是**唯一**能写凭据层的服务。
 */
export const inject = ['deepseekAccount', 'credentials']

/**
 * 凭据引用名。
 *
 * 与 `platform/cordis.patch.yml` 里 `llm-pi-ai.providers.dsharness-relay.apiKeyEnv`
 * **必须一致** —— 改名要同时改两处，否则模型调用会以 `MISSING_CREDENTIAL` 失败。
 * 大写加下划线是凭据引用的合法形状（`credentials/src/index.ts:19` 的
 * `/^[A-Za-z_][A-Za-z0-9_]*$/`）。
 */
export const DEFAULT_REF = 'DSHARNESS_MODEL_KEY'

/** 本产品取 Key 的端点（挂在 server 的 `/api/account/` 之下）。 */
export const MODEL_ACCESS_PATH = '/api/account/model-access'

/**
 * 失败后的重试间隔序列（毫秒）。
 *
 * 取 Key 失败**不该**让应用不可用：模型调用会以 `MISSING_CREDENTIAL` 报出来，
 * 用户重开一次或等下次重试即可。所以这里退避重试而不是抛错。
 */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000, 300_000]

/**
 * 请求超时。网关在另一个进程，挂住时必须自己收口，否则插件永远不落 Key。
 */
export const REQUEST_TIMEOUT_MS = 15_000

/**
 * 发送方标识。
 *
 * ⚠️ 生产 nginx 有一条反滥用规则：`User-Agent` 以 `node` 开头一律 **403**
 * （Node 的 `fetch` 默认 UA 就是 `node`）。本产品的 `product-gateway.ts` 与
 * `newapi-client.ts` 都为此显式设了 UA，这里同样要设，否则请求会拿到
 * HTML 403 而不是 JSON，排查时极具误导性。
 */
export const USER_AGENT = 'dsharness-client/0.1'

/**
 * 解析配置。`enabled: false` 可用于在本机临时关掉整条投递。
 *
 * @param config - 普通对象配置；无 schema。
 * @returns 归一后的设置。
 */
export function resolveConfig(config = {}) {
  const raw = config ?? {}
  const ref = String(raw.ref ?? DEFAULT_REF).trim() || DEFAULT_REF
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

/**
 * 从一次 `model-access` 响应里取出该用户的明文 Key。
 *
 * 成功包络是 `{ ok: true, access: { apiKey, apiKeyReason, keyState } }`；
 * `apiKey` 为 `null` 是**合法状态**（网关还没发出来 / 发失败），此时把
 * `apiKeyReason` 当原因回传，调用方据此决定是重试还是记一条日志。
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
 * @param options - `ref`/`requestTimeoutMs`/`fetch`（测试注入）。
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
        Number(options.requestTimeoutMs) > 0 ? Number(options.requestTimeoutMs) : REQUEST_TIMEOUT_MS
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
 * 挂载。
 *
 * 订阅账户状态：**已登录**时取 Key 并写入凭据层；**已退登**时删掉。
 * 订阅用官方 `account.watch(signal)`，所以「登录/退登/凭据被换」都会重跑，
 * 不需要我们自己的轮询或事件名。
 *
 * @param ctx - Cordis 上下文（`deepseekAccount` / `credentials` 已通过 `inject` 就绪）。
 * @param config - `{ enabled, ref, origin, requestTimeoutMs }`；无 schema。
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  if (!settings.enabled) {
    ctx.logger.warn(`[${name}] 已关闭（enabled: false）：模型 Key 不会自动投递`)
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
    ctx.logger.info(`[${name}] 已写入 ${settings.ref}（sk-…${apiKey.slice(-4)}）`)
  }

  async function clear(reason) {
    if (written === undefined) {
      // 也可能是上一次进程留下的：只有在确实存在时才删，避免无谓的文件改写。
      const existing = await credentials.describe(settings.ref).catch(() => undefined)
      if (existing === undefined || existing.configured !== true) return
    }
    await credentials.unset(settings.ref)
    written = undefined
    ctx.logger.info(`[${name}] 已清除 ${settings.ref}${reason === undefined ? '' : `（${reason}）`}`)
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
    ctx.logger.warn(`[${name}] 取模型 Key 失败：${result.status} ${result.reason ?? ''}`.trim())
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
        ctx.logger.warn(`[${name}] 同步失败，${String(delay)}ms 后重试：${reason}`)
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
        ctx.logger.warn(`[${name}] 订阅失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })

    return async () => {
      lifetime.abort()
      clearTimeout(timer)
      await loop
    }
  }, `${name}: model key delivery`)
}
