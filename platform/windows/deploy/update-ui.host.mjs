/**
 * dsharness-update-ui —— 「应用内检查更新」入口的**宿主半**（空实现）。
 *
 * ## 为什么需要它，而且必须是单独一个文件
 *
 * 客户端插件包（组合包）要出现在官方插件页上，前提是它**作为 Loader 行被挂载**：
 * 客户端 roster 只扫描有活 fiber 的 Loader 行
 * （`packages/client/modules/src/index.ts:984`，`entry.fiber === undefined` 直接跳过），
 * 而 Loader 挂载的是 `import()` 出来的 ESM 模块、解析的是它的 `apply`/`inject`
 * （`vendor/loader/src/config/entry.ts:223-238`）。
 *
 * 浏览器半（`update-ui.js`）是**经典脚本**：它由
 * `document.createElement('script')` 执行（`packages/client/modules/src/client/system.ts:16-29`），
 * 既不能有 `import`/`export`，也不能被 Node `import()` —— 在 Node 里它第一行就
 * 会撞上不存在的 `window`。一个文件不可能同时满足两者，所以这一行拆成两个：
 *
 * - `index.mjs`（本文件，来自 `entry`）：宿主半，什么都不做，只为让这一行有 fiber；
 * - `client.js`（来自 `clientEntry`）：浏览器半，注册 `settings.general.item` 那一行。
 *
 * ## 为什么不导出 `Config`
 *
 * 它没有任何配置：全部行为都在浏览器半，入口调用的也是官方 preload 已经暴露的
 * `dshDesktop.updates.open()`。`cordis.patch.yml` 里的行因此没有 `config:` 段，
 * 与 `model-key` / `update` 两个插件同一形状。
 *
 * 零依赖，与同目录其他插件同理由：装好的包目录里没有 `node_modules`。
 */

/** 稳定插件名（Cordis 用它做 fiber 标识与 dispose 归属）。 */
export const name = 'dsharness-update-ui'

/** 不需要任何服务：宿主半不注册任何东西。 */
export const inject = []

/**
 * 空实现。
 *
 * 故意为空：这一行的全部行为都在客户端半（设置里的那一个按钮），
 * 而它调用的是官方 preload 暴露的更新桥，不需要宿主侧配合。
 * 这个函数存在的唯一理由是让 Loader 有一个可挂载的插件体 ——
 * 没有活 fiber 的行不会被移交给浏览器。
 */
export function apply() {}
