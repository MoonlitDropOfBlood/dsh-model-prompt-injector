# AGENTS.md — dsh-model-prompt-injector

面向 AI agent 与协作者的开发指南。**读这里再动手**。

## 项目是什么

一个 **DeepSeek Harness（DSH）双面（Host + Client）插件**：为本地已配置的模型按路由（`provider/model`，或服务商级 `provider/*`）追加系统提示词，注入位置为**系统提示词末尾**。规则持久化在 `<DSH_HOME>/model-prompt-injector/config.json`，重启不丢；设置面板「模型提示词」页逐模型管理。

## 目录结构

```
dsh-model-prompt-injector/
├── package.json          # ESM 双面包：dsh.client: {platform:"web"} + exports(., /client, /typert, /cordis.patch.yml, /package.json)
├── index.js              # Host 半：ModelPromptInjectorService（TypertRemoteService 子类，类插件）
├── client.js             # Client 半：window.__ModuleLoader__.load bundle（设置页 + Remote 调用）
├── typert.host.js        # Typert Host manifest：modelPromptInjector Remote 服务的 schema/调用描述
├── cordis.patch.yml      # dsh bundle patch（仅一行 insert 挂载，无 config 覆盖）
├── test/                 # 投递状态机行为测试（loader 把三个宿主包重定向到 stubs，跑真实 index.js）
├── .github/workflows/release.yml  # 打 v* 标签：build+pack → npm OIDC → GitHub Release
├── AGENTS.md             # 本文件
├── README.md
└── LICENSE               # MIT
```

## 关键机制

### 1. 注入点：首次系统提示词 + 切换时通知（不是每 step 重复注入）

- Host 在 `[Service.init]` 里 `this.ctx.inject(["systemPrompt"], scope => { … })` 做两件事，生命周期与 systemPrompt 注册表绑定：
  1. **注册一个动态段落**（`model-prompt-injector:extra`，order 10250——0.1.7-rc.2 内置 `SECTION_ORDERS` 最大 `DEPLOYMENT_PERSONA_SUFFIX = 10200`（rc.2 新增 `WEB_SURFACE = 10100`），见宿主 `dsh-system-prompt/lib/index.js`，10250 落在系统提示词最末尾；0.1.5～0.1.7-rc.1 时代最大值是 `STRUCTURED_OUTPUT = 9900`、当时用 9950 即末尾，rc.2 起 order 升为 10250）；
  2. **注册 `agent/pre-step` 监听器**（root scope）做切换期投递。
- **投递状态机**（`this._delivered`，WeakMap keyed by 运行时 agent 对象，agent 回收自动清理）：
  - agent 的**首次**命中 → 规则文本由**系统提示词段落**投递（`_extraPrompt` 返回文本并记录 `{route, text}`）；
  - 之后**无任何变化**（同路由同文本）→ 段落返回 `""`，渲染器丢弃空段落——系统提示词**不重复注入**；
  - **变化**（切模型或改规则）→ 段落保持 `""`，由 `agent/pre-step` 监听器在**与宿主 `[model changed]` 通知同一注入点**追加一条 user 通知消息（`createUserMessage`，`source.plugin: "model-prompt-injector"`，root 监听器最外层执行，排在宿主通知之后）；切到无规则路由时发显式 `[model prompt rules cleared: …]` 清除通知，避免旧规则滞留；
  - 若某 agent 的管线**从不触发 pre-step**（意外情况），段落侧连见 3 次未投递的变化 → 回退为系统提示词投递，绝不丢更新。
- **为什么 root 监听器能收到所有 agent 的 pre-step**：宿主 `dsh-scope` 的 `scopeTarget` 载具过滤器对**无 scope 标签的监听器一律放行**（"a listener owned by an enclosing scope receives every descendant scope's events…events flow up the chain, never down"）；`installModelSelection` 同款 `(payload, next)` 瀑布签名，payload `{agent, messages, signal, step}`，决策形状 `{kind, messages}`（`kind === "reject"`、空 `messages`、`signal.aborted` 时不动决策）。
- **运行时路由来源（0.1.5+ 已变更）**：宿主新增模型选择层（`installModelSelection`，见 dsh-agent）用 `agent/request` waterfall 把请求路由覆盖为「UI 选择 → 已记录请求头 → 默认模型」；**`agent.options.provider/model` 只是创建时快照，UI 里切换模型或默认模型变更后与真实路由分叉**。插件 `_resolveRoute` 按同一优先级解析：① `sessionProjections.stateOf(session,"modelSelection").pending`（UI 选择，持久化镜像）② `session.requestHeader().config`（已记录实际路由）③ `agent.options`（无选择层的 subagent/SDK/workflow 子代理的真是路由）。**不要直接读 `agentDefaultModel.currentSelection()` 做默认回退**——会误伤无选择层的代理（把默认模型的规则注入到别的路由）。
- 未命中返回 `""`：`renderPrompt` 会丢弃空文本段落，未命中路由零开销。`_extraPrompt` 与 pre-step 监听器**绝不抛异常**（分别会毒化整次组装 / step 准入），全程 try/catch 兜底。
- **不要试图在 `llm/stream` waterfall 里改请求**：agent loop 发出的请求带 `markAgentLoopRequest` 标记且 **deep-frozen**，任何修改都会抛错——这是刻意设计（请求内容必须是会话日志的纯函数）。
- 动态插件原型（会话内 cordis_define 版 prompt-1）已端到端验证过该链路；本仓库是它的正式固化版，差异仅在：类插件形态、Typert Remote、config.json 持久化。
- **compaction 注意**：切换通知是对话消息，长会话被压缩后可能随通知一起裁掉（系统提示词的首次投递同理）。此时在设置页**重存一次规则**（文本变化触发重投）或**切换一次模型**即可恢复。

### 2. 规则模型与匹配

- 规则形状 `{ key, provider, model, prompt, updatedAt }`，`key = provider + "/" + model`；`model === "*"` 表示服务商级规则。
- 表按 key 升序排列：`*`（0x2A）先于任何字母数字，所以 `provider/*` 天然排在 `provider/xxx` 之前，注入顺序 = 服务商级 → 模型级，`_rulesText` 按表序拼接（`\n\n` 连接）。
- 匹配**大小写敏感**：模型 id 就是路由 id（如 `MiniMax-M3`），以「模型」设置页配置为准。
- `setRule` 空白 prompt = 删除该条；任何规则变更即 `_persist()`（fire-and-forget，失败静默——持久化失败绝不影响注入与 UI）。

### 3. 本地已配置模型枚举（与「模型」设置页同一逻辑）

- `llm.listConfigurableProviders()` 拿目录项 `{provider, displayName, settingsNs, settingsPath}`；`settings.get(ns)` 取解析值（命名空间未注册 = undefined = 未配置）。
- 「已配置」判定：`settingsPath.length === 0 || getPath(value, settingsPath) !== undefined`。
- 模型列表在 `[...settingsPath, "models"]`，数组项 `{id, name?, ...}`。
- `llm.listProviders()` 的 id 集合用于「运行中/未激活」徽标。
- pi-ai 家族的路由 id 由用户 profile 键生成（如 `minimax-cn`、`zai-coding-cn`），**不要硬编码猜测**。

### 4. Remote 三处同步

wire 变更必须三处一起改：

1. `index.js`：方法实现 + `[Service.init]` 里的 `markRemoteMethod`；
2. `typert.host.js`：zod schema（**strict**，字段必须整形状）+ invocation + `model.services[].types` 声明；
3. `client.js`：`CLIENT_REMOTE` 描述符（id/service/namespace/method 与 typert 一一对应）+ UI 调用。

Client 侧 zod 不可用，codec 用 passthrough schema（`{ parse: (v) => v }`）且**必须同时带 `create: () => schema` 工厂**（0.1.7-rc.1+ 的 client Remote 注册表校验 `create`，缺失时 `$mount` 抛 "strict codec has no create() factory"，见 §9）；返回值经 `pick()` 做双层信封解包。

### 5. Client 约定

- `window.__ModuleLoader__.load({ id, factory })`；`exports.inject = ["slots", "remote"]`；`await ctx.remote.$mount(CLIENT_REMOTE)` 自挂载命名空间（dsh-api-remotes 只挂官方命名空间）。
- **不要用 `?.` / `??`**（保守语法），用 `&&` / `||`；不要 `import`，用 `require("react")`。
- 按钮一律官方 Button 原子（`require("@deepseek-ai/dsh-client-ui-primitives")`，`variant: "primary"|"outline"|"ghost"`），样式一律 `--dsw-alias-*` token。
- CSS 注入：`document.createElement("style")` + `ctx.effect(() => () => styleTag.remove())`。
- 设置页 Slot：`settings.section`，id `model-prompt-injector`，order 12（models=10 之后），label `() => "模型提示词"`。
- 设置导航图标：`settings.section` 不投影图标字段（外壳统一画齿轮），用 MutationObserver 给文本等于 label 的 nav 行打 `data-dsh-model-prompt-injector-settings-nav` 标记，CSS 隐藏齿轮并以 currentColor mask 画 Lucide message-square-plus。换图标只需替换 CSS data URI 里的 SVG。

### 6. 标准安装 = dsh bundle

`package.json` 的 `dsh.bundle.patch` 指向包内 `cordis.patch.yml`（仅一行 `- insert:` 挂载行，**不要**对不存在的 id 用普通 `- id:`）：

```bash
dsh plugin --profile web add <包名或本地路径>   # 本地路径走 link:，前提是插件目录已有 node_modules
# 重启 DSH 生效
```

link: 调试时对齐宿主依赖版本（避免双副本漂移）：

```bash
# 0.1.5-rc.x 宿主：cordis@4.0.2 + typert-protocol@0.1.5-rc.2 + dsh-llm@0.1.5-rc.2；0.1.7-rc.1 宿主：cordis@4.0.4 + typert-protocol@0.1.7-rc.1 + dsh-llm@0.1.7-rc.1
npm install --no-save --registry=https://registry.npmjs.org @deepseek-ai/cordis@4.0.2 @deepseek-ai/dsh-typert-protocol@0.1.5-rc.2 @deepseek-ai/dsh-llm@0.1.5-rc.2 zod@4.5.4
```

宿主版本从桌面安装目录的 `.pnpm` 仓查（`dsh\node_modules\.pnpm`）。

### 7. DSH 0.1.5-rc.2 兼容性（2026-09-16/17 验证）

- 注入链路在 0.1.5-rc.2 下**端到端可用**。typert-protocol 0.1.2-rc.1 与 0.1.5-rc.2 的 `lib/index.js` **逐字节相同**，本地旧副本可继续工作。
- **调试盲区（重要）**：`Service.listService` 服务目录**不枚举 TypertRemoteService 子类**——`pluginInventory`、`modelPromptInjector` 这类服务即使完全正常也查不到（曾被误判为"插件未加载"）。判定插件是否存活的正确方法：① HTTP RPC 调 `pluginInventory/list`（查 `include:model-prompt-injector` 行 enabled=true 且 fiberPhase=active）；② 直接调 `modelPromptInjector/getState`（返回规则表即证明服务+init 完成）。RPC 调用法：先 `GET /?token=<launchToken>` 换 cookie，再 `POST /api/<namespace>/<method>`，body `{type:"client-request", rpcId, method, payload:{args:{}}}`。launchToken 在桌面日志 `dsh-desktop-main.log` 的 URL 里。
- 加载时序：带 `--expose-internals` 启动时插件行**延迟激活**（约 3–15s，`_loadPersisted` 的 await 让出事件循环），属正常现象，勿误判为未加载。
- `AssembleContext` 类型已改为 `{ scope?, signal? }`，**不再声明 `agent` 字段**；但运行时 `assembleContextFor` 仍返回 `agent`（官方 `{{provider}}/{{model}}` 变量也仍读 `context.agent?.options.provider`），机制未变——只是类型上属于未声明字段，升级宿主时留意。
- `peerDependencies` 的 typert-protocol 范围必须覆盖当前宿主（现已加 `^0.1.5-rc.2`），否则新装/升级时 pnpm peer 校验会拒装。

### 8. DSH 0.1.7-rc.1 兼容性 + dshmarket 版本声明（2026-09-25 验证）

- **加载不上的根因**：0.1.7-rc.1 携带 typert-protocol `0.1.7-rc.1` 与 cordis `~4.0.4`，旧 peer 范围（typert `… || ^0.1.5-rc.2`、cordis `4.0.1 || 4.0.2`）均不满足（semver 实测 false），pnpm peer 校验直接拒装。修复：typert 加 `|| ^0.1.7-rc.1`、cordis 改 `^4.0.1`。
- **API 面核实**（npm pack 0.1.7-rc.1 包逐文件对比本机 0.1.5-rc.3）：typert-protocol `Remote` 装饰器/`TypertRemoteService(ctx, key)`/`addMarkerInitializer` 全兼容（纯新增 owned-value/json-value）；system-prompt `section({name,order,text})` 不变、`STRUCTURED_OUTPUT=9900` 仍为最大 order（新增 3e3/3100 均小于它，9950 仍在末尾），新增 `interpolate:false` 不影响本插件；session-projection `lib/index.js` **逐字节相同**；cordis 4.0.4 仅内部重构，`Service`/`ctx.inject` 未动。无需改代码。
- **dshmarket 版本声明**（dshmarket 1.48.0 `lib/discovery-compatibility.js` 核实）：市场按需拉 npm latest manifest 缓存 24h，读 `engines.dsh`（顶层优先）或 `dsh.engines.dsh`（严格 semver + includePrerelease）与 `@deepseek-ai/dsh*` peerDependencies（方向性判定；cordis/schemastery 不计），取交集显示"宿主要求 {range}"并驱动筛选与安装阻断。本插件已加 `"engines": { "dsh": ">=0.1.5-rc.2 <0.2.0" }`（npm/pnpm 对未知 engine key 只警告不拦截，安装无影响）。
- semver 陷阱：prerelease（如 `0.1.7-rc.1`）**不满足**不含同 tuple prerelease 比较子的范围（`^0.1.5-rc.2` 不含）——peer 里每个新 rc 线必须显式加 `^0.1.x-rc.n`；engines.dsh 因市场用 includePrerelease 无此问题。同 tuple 内的 rc.n 递进（rc.1 → rc.2）**不需要**新加比较子：`^0.1.7-rc.1` 展开后含 `>=0.1.7-rc.1` 同 tuple prerelease 比较子，rc.2 天然满足。

### 9. DSH 0.1.7-rc.2 兼容性 + 误判「不兼容被卸载」事故复盘（2026-09-26 验证）

- **真正的 rc.1+ 不兼容点（client codec，1.1.1 修复）**：0.1.7-rc.1+ 的浏览器端 Remote 注册表校验 codec **必须携带 `create()` 工厂**（旧宿主 ≤ 0.1.5-rc.3 只要求 `schema.parse`），缺 `create` 时 `ctx.remote.$mount` 抛 `"strict codec has no create() factory"` → client 模块加载失败（宿主半不受影响，RPC 照常通——这正是此前误判「加载不上/不兼容」却查不到原因的盲区）。修复：每个 codec 同时带 `schema` 与 `create: () => schema`（同 dsh-agent-approval 1.7.0 的 `strictCodec` 模式）。**教训：宿主大版本升级时，client 侧 Remote codec 契约要与宿主侧 API 一起核对。**
- **宿主半与 0.1.7-rc.2 兼容**。宿主唯一加载闸门 `evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot/lib/index.js`，只查名为 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peerDependencies，`semver.satisfies(runtime, req, {includePrerelease:true})`）对 1.1.x manifest 返回 `issue: undefined`（用宿主自己的函数实测）。所有用到的宿主 API（typert `TypertRemoteService`、dsh-llm `createUserMessage/listProviders/listConfigurableProviders`、system-prompt section、`installModelSelection`/sessionProjections）在 rc.2 全部存在。
- **profiles 桥接目录（关键机制，本次新发现）**：`~/.dsh/profiles/node_modules/@deepseek-ai/*` 是一整套**指向宿主运行时的 Junction**（如 `cordis → …\DeepSeek Harness Desktop\dsh\node_modules\@deepseek-ai\cordis`）。registry 安装的插件位于 `<profile>/node_modules/<scope>/<pkg>`，Node 向上走 node_modules 时命中 `~/.dsh/profiles/node_modules`——**所有 `@deepseek-ai/*` 导入一律解析到正在运行的宿主副本，不存在双副本漂移**。这就是 registry 安装从不需要对齐依赖的原因；§6 的 link: 对齐仍然必要，因为 link: 插件在 workspace（桥接路径之外），向上解析走不到它。
- **SECTION_ORDERS 变化（唯一真代码影响）**：rc.2 在 9900 之上新增 `WEB_SURFACE = 10100`、`DEPLOYMENT_PERSONA_SUFFIX = 10200`，order 9950 不再是末尾（1.1.0 的规则文本落在 web-surface/deployment-persona 段之前）。修复：SECTION_ORDER 9950 → **10250**（1.1.1）。
- **事故链复盘**：9/25 18:27 桌面升级重启，新核心 spawn 后 **199ms 即 exit 1**（远早于插件加载完成的正常 3s+，恢复器 `parseBootFailure` 未归因任何插件 → 无 plugin-recovery 日志行），49s 后重试即成功——**且当时 profile package.json 里插件仍在**，即 0.1.7-rc.2 下插件实际正常加载运行了 16 分钟。02:44（本地）package.json/pnpm-lock 变更移除本插件与 dsh-token-stats，无任何自动化机制留痕（桌面日志/市场日志均无），判定为 UI 手动卸载。诱因：升级瞬间的一次性启动失败 + dshmarket 24h 发现缓存仍显示旧 manifest facts（v1.0.2），造成「不兼容」观感。**教训：判定兼容性用宿主 `evaluatePluginCompatibility` 实测，不要凭启动失败面板或市场徽标下结论。**
- **dshmarket 发现缓存**：`<profile>/.dsh-market/discovery-compatibility-v1.json` 缓存 npm manifest facts 24h（conclusions 不缓存）。发布新版本后若市场徽标不更新，可删该文件强制刷新（schema 带版本号，安全）。

## 发布

- 打 `v*` 标签推送 GitHub：`.github/workflows/release.yml` 三个 job——build（node --check + npm pack + artifact）→ publish-npm（**OIDC Trusted Publishing**，Node 24 + npm ≥ 11.5.1，无静态 token）→ GitHub Release（带 tgz）。
- **npm 首版需本地 bootstrap**（静态 token 会撞 EOTP 且非 TTY 收不到授权 URL）：用户本地 `npm publish --registry=https://registry.npmjs.org`，然后在 npmjs.com 包设置配置 trusted publisher（本仓库 + `.github/workflows/release.yml`），之后 tag 全自动。
- **插件市场**（awesome-dsh-plugin）：fork 加 `data/plugins/MoonlitDropOfBlood__dsh-model-prompt-injector.yml` + `node scripts/generate-readme.mjs` 重生成 README，分支 `add-moonlitdropofblood-dsh-model-prompt-injector` 推 fork 开 PR。**CI 要求仓库创建满 1 天 + ≥10 commit**。
- git 身份：`duke <wwhbygx@sina.com>`（勿改）。

## 常规注意事项

- 监听器/文本函数**绝不抛异常**（注入路径已全程 try/catch）。
- 规则是全局的：对所有会话与子代理生效（这是有意语义——提示词跟随模型路由，不跟随会话）。
- 不写任何自定义**事件**；唯一的对话痕迹是切换/清除通知消息（`source.plugin: "model-prompt-injector"`，与宿主 model-selection 通知同机制），唯一持久化是 config.json。
