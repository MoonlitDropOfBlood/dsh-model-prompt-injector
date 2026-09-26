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
  1. **注册一个动态段落**（`model-prompt-injector:extra`，order 9950——内置 `SECTION_ORDERS` 最大 `STRUCTURED_OUTPUT = 9900`，见宿主 `dsh-system-prompt/lib/index.js`，9950 落在系统提示词最末尾）；
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

- `llm.listConfigurableProviders()` 拿目录项 `{provider, displayName, settingsNs, settingsPath}`；`settings.describe()` 取一次快照、按 `descriptor.ns` 建表，读 `descriptor.value` 作为解析值（命名空间不在快照里 = undefined = 未配置）。**不要用 `settings.get(ns)`**：DSH 0.1.7 已移除，调用会抛进逐项 catch，目录静默变空。
- 「已配置」判定：`settingsPath.length === 0 || getPath(value, settingsPath) !== undefined`。
- 模型列表在 `[...settingsPath, "models"]`，数组项 `{id, name?, ...}`。
- `llm.listProviders()` 的 id 集合用于「运行中/未激活」徽标。
- pi-ai 家族的路由 id 由用户 profile 键生成（如 `minimax-cn`、`zai-coding-cn`），**不要硬编码猜测**。

### 4. Remote 三处同步

wire 变更必须三处一起改：

1. `index.js`：方法实现 + `[Service.init]` 里的 `markRemoteMethod`；
2. `typert.host.js`：zod schema（**strict**，字段必须整形状）+ invocation + `model.services[].types` 声明；
3. `client.js`：`CLIENT_REMOTE` 描述符（id/service/namespace/method 与 typert 一一对应）+ UI 调用。

Client 侧 zod 不可用，codec 用 passthrough schema（`{ parse: (v) => v }`）；**strict codec 两面都必须带 `create()` 惰性工厂**（DSH 0.1.7-rc.1 起强制，缺了 host manifest 整份被拒、client `$mount` 抛错），`schema` 保留给旧宿主；返回值经 `pick()` 做双层信封解包。

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
- semver 陷阱：prerelease（如 `0.1.7-rc.1`）**不满足**不含同 tuple prerelease 比较子的范围（`^0.1.5-rc.2` 不含）——peer 里每个新 rc 线必须显式加 `^0.1.x-rc.n`；engines.dsh 因市场用 includePrerelease 无此问题。

## 发布

- 打 `v*` 标签推送 GitHub：`.github/workflows/release.yml` 三个 job——build（node --check + npm pack + artifact）→ publish-npm（**OIDC Trusted Publishing**，Node 24 + npm ≥ 11.5.1，无静态 token）→ GitHub Release（带 tgz）。
- **npm 首版需本地 bootstrap**（静态 token 会撞 EOTP 且非 TTY 收不到授权 URL）：用户本地 `npm publish --registry=https://registry.npmjs.org`，然后在 npmjs.com 包设置配置 trusted publisher（本仓库 + `.github/workflows/release.yml`），之后 tag 全自动。
- **插件市场**（awesome-dsh-plugin）：fork 加 `data/plugins/MoonlitDropOfBlood__dsh-model-prompt-injector.yml` + `node scripts/generate-readme.mjs` 重生成 README，分支 `add-moonlitdropofblood-dsh-model-prompt-injector` 推 fork 开 PR。**CI 要求仓库创建满 1 天 + ≥10 commit**。
- git 身份：`duke <wwhbygx@sina.com>`（勿改）。

## 常规注意事项

- 监听器/文本函数**绝不抛异常**（注入路径已全程 try/catch）。
- 规则是全局的：对所有会话与子代理生效（这是有意语义——提示词跟随模型路由，不跟随会话）。
- 不写任何自定义**事件**；唯一的对话痕迹是切换/清除通知消息（`source.plugin: "model-prompt-injector"`，与宿主 model-selection 通知同机制），唯一持久化是 config.json。
