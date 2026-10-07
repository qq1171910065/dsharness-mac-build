/**
 * dsharness-update — 「检查更新」，做在 platform 层，不动上游源码。
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
 * 要走活那条路必须做代码签名（`forceCodeSigning: !unsigned`），本产品没有证书。
 * 所以「检查更新」只能自己实现，而**自有代码一律放 platform/**。
 *
 * ## 版本从哪来
 *
 * 产品 server 早就有 `GET /api/config/version`（`server/src/routes/api.ts:240`），
 * 回 `{ ok, release }`，而 `release` 就是管理端维护的发布信息。这里直接读它 ——
 * **不新增一套版本清单**，也不去读 OSS 上的 `latest.yml`（那需要签名才有意义）。
 *
 * 当前安装版本从 `<DSH_HOME>/dsharness-install.json` 读：那是**安装期**由
 * `deploy-entry.mjs` 用 NSIS 的 `${VERSION}` 写下的。之所以不猜：未签名构建里
 * 只有安装器知道用户装的是哪个版本。
 *
 * ## 它做什么 / 不做什么
 *
 * **做**：告诉你「现在是哪个版本、最新是哪个、有没有新版、新版在哪下载」。
 * **不做**：下载与安装。未签名构建上静默替换可执行文件既做不到也不该做；
 * 页面上给的是下载链接，用户自己决定。
 *
 * 零依赖：与 `host-auth.mjs` / `model-key.mjs` 同理由 —— 本文件由
 * `platform/provision.mjs` 装成组合包，包目录里没有 `node_modules`。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 稳定插件名（Cordis 用它做 fiber 标识与 dispose 归属）。 */
export const name = 'dsharness-update'

/** 只注入 `webServer`：这一面就是两个只读 HTTP 路由。 */
export const inject = ['webServer']

/**
 * 本产品 server 的 origin。
 *
 * ⚠️ 必须与 `platform/build-deploy-payload.mjs` 的 `DEFAULT_PLATFORM_ORIGIN`
 * 一致 —— `update.test.mjs` 会把两者比一遍。这里写字面量而不是 import，是因为
 * 装好的包只有 `index.mjs` 一个文件，import 不到兄弟模块。
 */
export const DEFAULT_ORIGIN = 'https://www.czmanong.com'

/** 版本清单端点（产品 server 已有，复用它的前缀路由，不必动网关）。 */
export const RELEASE_PATH = '/api/config/version'

/** 检查更新页与它的 JSON 面。 */
export const UPDATE_PATH = '/dsharness/update'
export const UPDATE_JSON_PATH = '/dsharness/update.json'

/** 安装期写下的版本记录（`deploy-entry.mjs` 用 NSIS 的 `${VERSION}` 写）。 */
export const INSTALL_RECORD = 'dsharness-install.json'

/** 请求超时。清单在远端，挂住时必须自己收口，否则页面永远转圈。 */
export const REQUEST_TIMEOUT_MS = 15_000

/** 发送方标识（生产 nginx 有 `User-Agent: node*` 一律 403 的规则）。 */
export const USER_AGENT = 'dsharness-client/0.1'

/** 解析配置；`enabled: false` 可整面关掉。 */
export function resolveConfig(config = {}) {
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
 * 拆一个 semver 成可比较的数字段。
 *
 * 不引 semver 包（包目录里没有 `node_modules`）。够用的范围就是本产品用到的形态：
 * `0.2.1-alpha.1.20261007.2`。规则：数字段按数值比；**有预发布段的小于没有的**
 * （`1.0.0-rc < 1.0.0`），预发布段之间先按数字、再按字典序。
 *
 * @param value - 版本字符串。
 * @returns `{ release: number[], prerelease: string[] }`。
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
 * @param options - `origin` / `home` / `requestTimeoutMs` / `fetch` / `readInstall`（测试注入）。
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

/** HTML 转义（页面只显示版本号与 URL，仍然转义：不依赖「值一定是安全的」）。 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
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
    '<p class="lead">本产品的版本清单由产品服务端下发。未做代码签名的安装包不能自动安装，请从下面的链接手动下载覆盖安装。</p>',
    '<table>',
    ...rows,
    '</table>',
    result.notes === undefined ? '' : `<pre>${escapeHtml(result.notes)}</pre>`,
    '<p><a href="">重新检查</a> · <a href="/dsharness/gateway.json">网关信息</a></p>',
    '</main></body></html>',
    '',
  ].join('\n')
}

/** JSON 响应（不缓存）。 */
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
 * 挂载两个只读路由。
 *
 * ⚠️ 为什么不需要像 `host-auth.mjs` 那样放行 `authorizeIndex`：`webServer` 的
 * `match()` 是**先查 exact 表**再走前缀兜底（`packages/host/webserver/src/index.ts:319-328`），
 * 所以 `kind: 'exact'` 的路由根本不会落到 `frontend-static` 的 index 处理上。
 *
 * @param ctx - Cordis 上下文（`webServer` 已通过 `inject` 就绪）。
 * @param config - `{ enabled, origin, home, requestTimeoutMs }`；无 schema。
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)
  if (!settings.enabled) {
    ctx.logger.warn(`[${name}] 已关闭（enabled: false）：不提供检查更新`)
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
  }), `${name}: ${UPDATE_JSON_PATH}`)

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
  }), `${name}: ${UPDATE_PATH}`)

  const record = readInstallRecord(settings.home)
  ctx.logger.info(
    `[${name}] 已启用：${UPDATE_PATH} 显示 ${record === undefined ? '（本 home 无安装记录）' : record.version}`
    + `，清单 ${settings.origin}${RELEASE_PATH}`,
  )
}
