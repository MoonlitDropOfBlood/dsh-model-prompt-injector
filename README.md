# dsh-model-prompt-injector

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）中**本地已配置的模型**追加系统提示词的插件：按 `provider/model` 精确匹配（或 `provider/*` 服务商级通配）把规则文本注入到**系统提示词末尾**，在设置面板中逐模型管理，规则**持久化保存、重启不丢**。

## 功能

- **按模型注入**：每次向模型发起请求时，命中规则的提示词追加到系统提示词末尾（内置段落排序之后，order 10250），对主会话、子代理（subagent / workflow）同样生效。
- **两级规则**：`provider/*` 服务商级规则对该服务商所有模型生效；`provider/model` 模型级规则只对该模型生效；两者同时存在时按「服务商级 → 模型级」顺序叠加。
- **设置页管理**：设置 → 「模型提示词」页自动列出本地已配置的服务商与模型（与「模型」设置页同一数据源），逐行添加/编辑/清除，已注入的条目带徽标与内容预览。
- **持久化**：规则保存在 `<DSH_HOME>/model-prompt-injector/config.json`（默认 `~/.dsh/model-prompt-injector/config.json`），重启 DSH 后自动恢复。
- **即时生效**：保存规则后，下一次模型请求即携带新提示词，无需重启。

## 安装（标准 DSH bundle）

```bash
dsh plugin --profile web add @duke-dsh-plugins/dsh-model-prompt-injector --registry=https://registry.npmjs.org
```

> 显式指定 npmjs registry，避免被本地/镜像 registry 配置带偏。安装后**重启 DSH**（Host 加载、typert 注册、client bundle 注入都在启动时发生），设置面板出现「模型提示词」页。

卸载：

```bash
dsh plugin --profile web remove @duke-dsh-plugins/dsh-model-prompt-injector
```

## 使用

1. 打开 **设置 → 模型提示词**（在「模型」页之后）。
2. 页面列出本地已配置的服务商卡片；每张卡片第一行是「所有模型（服务商级）」，其下是该服务商配置中的每个模型。
3. 点击目标行的「添加提示词 / 编辑」，在文本框中编写要追加的系统提示词，**保存**即时生效；「清除规则」删除该条。
4. 规则匹配是**路由级精确匹配**（`provider/model`，大小写敏感，如 `minimax-cn/MiniMax-M3`）；模型 id 以「模型」设置页中配置的值为准。

## 规则示例

| 规则 key | 作用范围 |
| --- | --- |
| `deepseek-official/*` | DeepSeek 官方路由的所有模型 |
| `minimax-cn/MiniMax-M3` | 仅 MiniMax-M3 |
| `zai-coding-cn/glm-5.3` | 仅 GLM-5.3 |

典型用法：给弱一些的模型追加一段严谨的工作协议（先验证再声称、最小改动、契约对齐……）以提升输出质量；给特定模型追加项目约定或输出格式要求。

## 实现要点

- 注入基于 `systemPrompt` 服务的**动态段落**：段落文本是每次模型 step 组装时求值的函数，运行时组装上下文携带 `agent`，按宿主模型选择层的同一优先级解析本次请求的目标路由（UI 选择的模型 → 已记录请求头 → 创建时 options，DSH 0.1.5+ 下 `agent.options` 只是创建时快照）做规则匹配；未命中返回空串，渲染器自动丢弃空段落（零开销）。
- **不重复注入**：每个 agent 的**首次**命中由系统提示词投递（规则在系统提示词末尾）；之后内容不变时段落恒为空。模型**切换**或**规则编辑**时，规则改经 `agent/pre-step` 注入点以一条用户通知消息投递——与宿主 `[model changed]` 通知同一时机、紧随其后；切到无规则的路由会收到显式的 `[model prompt rules cleared: …]` 清除通知。
- 规则读写走插件自有的 Typert Remote 服务（`modelPromptInjector.getState / setRule`），Client 经 `ctx.remote.$mount` 自挂载命名空间后调用。

> 注意：切换通知是对话消息，长会话被压缩后可能随通知一起被裁掉。若发现规则“丢失”，在设置页重存一次规则或切换一次模型即可重新注入。

## 开发

```bash
npm run check   # node --check index.js client.js typert.host.js
```

本地调试安装（link:，插件目录需已有 node_modules，见 AGENTS.md）：

```bash
# 依赖版本对齐本机宿主（0.1.5-rc.x → cordis@4.0.2 + typert@0.1.5-rc.2；0.1.7-rc.1 → cordis@4.0.4 + typert@0.1.7-rc.1）
npm install --no-save --registry=https://registry.npmjs.org @deepseek-ai/cordis@4.0.2 @deepseek-ai/dsh-typert-protocol@0.1.5-rc.2 zod@4.5.4
dsh plugin --profile web add /path/to/dsh-model-prompt-injector
# 重启 DSH 生效
```

**宿主要求**：`engines.dsh` 声明 `>=0.1.5-rc.2 <0.2.0`（dshmarket 按此显示"宿主要求"并做安装适配判定）。

## 发布

打 `v*` 标签推送 GitHub，`.github/workflows/release.yml` 自动构建 tgz、发布 GitHub Release，并经 npm OIDC Trusted Publishing 发布到 npmjs（需在 npmjs.com 包设置中先配置 trusted publisher：本仓库 + `.github/workflows/release.yml`）。

## License

MIT © duke
