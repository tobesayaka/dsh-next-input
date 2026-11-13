# dsh-next-input

[English](README.md) | 中文

一个 DeepSeek Harness（DSH）Web 输入框插件。DSH 回答结束后，它会用当前模型预测你下一句可能输入的内容，以浅色“幽灵文字”预填在空输入框中；按 **Tab** 即可采纳。

## 功能

- 在一轮回答结束、会话空闲时读取最近的用户/助手文本。
- 只取已加载事件窗口中的文本，不读思考过程或注入上下文；Max 模式可以额外带上那一轮的工具调用摘要（见 [Max 模式](#max-模式)）。
- 默认跟随当前对话中选中的模型（取不到时用产生最近一条回答的模型），也可以在设置里固定一个更快的预测路由。
- Host 按 `sessionId + answerKey` 缓存预测；切会话、overlay 重挂载、刷新页面后可以恢复。
- 只有草稿为空、会话空闲时显示 ghost。
- 预测超过一行时在输入框宽度内自动折行，和正常打字一样，内容不会被截断；Max 模式还可以不再把预测压成单行。
- 按 Tab 采纳；默认开启“普通 Enter 采纳并发送”。
- 跟随 DSH 界面语言：输入框提示、读屏播报和设置页随 DSH 语言实时切换中英文（见[界面语言](#界面语言)）。
- 不把对话写入预测缓存、会话日志或 `localStorage`。

## 界面语言

插件**没有自己的语言设置**。输入框 ghost 提示、读屏播报和设置页都跟随 DSH 的界面语言——在 **设置 → 通用 → 语言** 里选一次；切换后无需刷新即可重渲染。

只提供两种基线语言：**简体中文（`zh`）** 和 **English（`en`）**。两本字典一次性注册到 DSH 的 locale 服务（`@deepseek-ai/dsh-client-locale`），命名空间只有 `dsh-next-input` 一个，且 `locale` 是必填依赖：

```js
inject: ['slots', 'locale'],
apply(ctx) {
  ctx.effect(
    () => ctx.locale.register(NS, { zh: zhDictionary, en: enDictionary }),
    'dsh-next-input: dictionaries',
  );
}
```

- `translate(ctx, key)` 读 `ctx.locale.bind(NS)(key)`；`enDictionary` 同时是 `bind` 原样返回 key 时（没有语言服务，例如纯浏览器测试）的兜底文案。
- `subscribeLocale` / `localeRevision` 接给 `React.useSyncExternalStore`，切语言时 ghost 和设置页重渲染；文案本身从不缓存。
- 设置分区侧栏的 `label` 是函数 `() => translate(ctx, 'settingsNav')`，所以侧栏行跟着语言变，不需要重新注册。
- `locale/en.json`、`locale/zh.json` **只**给插件管理器读取插件卡片的元信息（`meta.title`、`meta.description`），不要往里放界面文案。

不要加插件自己的语言选择器、不要注册第三种语言、也不要把语言偏好写进 `settings.json`。这条约定的完整背景见上层 [README](../README.md) 的「多语言：只跟随 DSH，只做 zh / en」。

## 环境要求

- DSH Web UI，且存在 `conversation.input.overlay`、`settings.section`、`settings.section.icon` 插槽。
- 已注册的 LLM provider 路由。
- 满足 `package.json` 中 `engines` 要求的 DSH/Node 版本。

## 安装

```bash
cd dsh-next-input
npm test
npm run check
```

然后在 DSH 的 Plugin Manager 中使用 **Install bundle**，或让 Agent 执行：

```text
plugin_manager install_bundle target=/Users/ming/py/dsh-plugin/dsh-next-input
```

bundle 没有额外依赖。安装后确认 `next-input` 这一行处于启用状态。

## 使用

1. 回答结束后保持输入框为空。
2. 输入框内会出现灰色预测和 `Tab` 键帽。
3. 按 `Tab` 填入完整建议。
4. 默认（`enterToSend` 开启）普通 `Enter` 会采纳并发送；`Shift+Enter` 仍是换行。
5. 开始打字、开始新一轮、按 `Esc` 或采纳后，预览消失。

预测只是预览文本；关闭“采纳并发送”后，不点发送就不会提交任何内容。

## 设置页

打开 **设置 → 下一步输入**：这是插件自己的一级设置分区，有独立的侧栏入口和图标，排在「Shell」和「内置插件」之间。现在只有这一处，**设置 → 插件** 下不再有它的标签页。可以调整：

| 控件 | 含义 |
|---|---|
| Enter 采纳并发送（`enterToSend`） | 普通 Enter 采纳并提交；Tab 仍然只采纳。默认开启。 |
| 打开会话时预生成（`predictOnActivate`） | 当前回答没有缓存时，打开空闲会话会生成一次预测；会多一次模型调用。默认开启。 |
| 预测 provider / model | 可选的固定预测路由，从已注册 provider 及其模型目录中选择。默认 provider 停在“跟随当前对话的模型”：每次预测使用该对话里选中的模型，取不到时回退到产生最后一条回答的模型。只有想固定一个更快、专用的模型时才需要选 provider + model。 |
| 最大输出 token（`maxTokens`） | 辅助模型调用的输出上限。 |
| 超时（毫秒） | 单次预测的墙钟上限。 |
| 最大上下文字符 | 送入预测的对话字符上限。 |
| 最大消息条数 | 送入预测的消息条数上限。 |
| 最大建议字符 | 返回给输入框的建议最大长度。 |
| 用量（本次 Host 运行） | 只统计本插件：预测调用次数、输入/输出/总计 token、平均每次、命中缓存的输入、缓存直接命中次数、被拒绝的重复请求；“重置计数”只清计数，不改设置。 |

- **保存** 立即应用到下一次预测；不会重载插件，也不会清空 Host 预测缓存。
- 配置保存在插件的用户数据文件：
  `<DSH_HOME>/next-input/settings.json`（通常是
  `~/.dsh/next-input/settings.json`）。
- `cordis.patch.yml` 里该行的 `config` 仍然作为基线；**重置为 profile 默认值** 会删除设置文件并回退到基线。
- provider/model 下拉通过 `llm.listProviders()` 和 `llm.listModels()` 填充；已经不在目录里的旧值会作为 `(unavailable)` 选项保留。
- 想恢复“跟随当前对话的模型”，在 provider 下拉里选回这一项即可，它会同时清空两个字段。
- 用量数字来自每次预测时 provider 返回的 `usage`，只保存在 Host 进程内存里（DSH 重启清零）；`GET /api/next-input.usage` 返回同一组数字。
- 设置页和输入框内的文案跟随 DSH 界面语言（设置 → 通用 → 语言）；字典如何注册见[界面语言](#界面语言)。

## Max 模式

**默认关闭。** 总开关关着时，下面所有键都不起作用，预测行为与引入 Max 模式之前完全一致：同样的提示词、同样的单行清洗、同样的上下文打包、同样的最低推理档位。

在 **设置 → 下一步输入 → Max 模式** 打开。总开关控制七个子开关，每个都可以单独关掉，方便判断到底是哪一项起了作用。

| 子开关 | 配置键 | 它改变什么 |
|---|---|---|
| 带上工具活动 | `includeToolActivity` | 把最近那一轮的工具调用摘要加进预测请求。文件按路径列出并去重，命令只保留最近 4 条并注明省略了多少，失败的标 `[failed]`。绝对路径收成末两段，与对话里的写法对得上。上限 1200 字符，按行边界截断。 |
| 改进上下文打包 | `smartPack` | 先预留最早那条提问，再排最后一条提问与最终回答。否则长回答很多的会话会把最初的提问完全挤出预算。仍然是字符预算，不是 token。 |
| 允许多行建议 | `allowMultiline` | 保留换行，按行边界截断，不再压成单行。`maxSuggestionChars` 还是默认 `140` 时，Max 模式用 `400`；显式设置的值优先。 |
| 推理档位 | `reasoningEffort` | `model` 不再强塞最低档，交给 provider 决定。`low` / `medium` / `high` 固定一档，且只在模型确实声明了该档时才发。 |
| 失败后重试 | `retryOnFailure` | 退避 250 ms 后重试一次。重试共用同一个墙钟上限，`timeoutMs` 仍然约束整次预测。 |
| 只在回答结束后预测 | `predictOnEndOnly` | 忽略 `predictOnActivate`，打开会话不再多花一次模型调用。 |
| 预测提示词 | `promptVariant` | `next` 先判断处境（AI 在提问 / 等确认 / 刚交付结果），再给出下一步动作；下一步带多个判断点时，主动用编号清单、要点列表或代码块，而不是压成一句。`legacy` 是原来的提示词。 |

**上下文与输出预算。** Max 模式还放宽两个预算，规则与 `maxSuggestionChars` 一致——**只在设置仍是默认值时**改用 Max 模式的默认值，显式设置的值优先：

| 设置 | 默认 | Max 模式 | 为什么 |
|---|---|---|---|
| 最大上下文字符 `maxContextChars` | 8000 | 32000 | 8000 字符只够放下两三轮长回答，模型看不到你平时怎么写。Codex 是直接继承整条线程，这里用更宽的字符预算逼近它。 |
| 最大消息条数 `maxMessages` | 24 | 64 | 同上；长会话里 24 条会先于字符预算用尽。 |
| 最大输出 token `maxTokens` | 512 | 1024 | 结构化预测加推理模型的隐藏 token 放不进 512。仍受 20 秒超时约束。 |

**打包发生在浏览器侧。** 客户端在 overlay 挂载时读一次这些值并缓存，所以：

- 提示词、推理档位、重试、多行、工具活动的改动，**保存后**就作用于下一次预测。
- 改动 `smartPack`、`includeToolActivity` 或上面两个上下文预算，需要**刷新页面**，才会影响客户端实际发出去的内容。
- 这一次读取失败时，所有预测退回 Max 之前的行为，而不是报错。
- Max 关闭时客户端仍用固定的 7000 字符 / 24 条（0.5.x 行为），不读这两个设置。

多行是**达标形态，不是不合格**：下一步天然需要结构时（贴报错、列多个条件、给一组指令），它比硬压成一行更接近真人的输入。长度判据针对的是「话多但没内容」，不是行数。

## 工作原理

1. **客户端触发**：一轮回答结束，overlay 读取最近事件窗口并调度一次预测。
2. **Host 调用**：`POST /api/next-input.predict` 校验会话与 provider，优先保留最后一条用户消息和最终回答，然后以最低 reasoning effort 调用 `ctx.llm.prepareCall()`。
3. **缓存**：成功预测写入 Host 进程内存，key 为 `sessionId + answerKey`（24 小时 TTL，最多 100 条）。
4. **恢复**：切会话、刷新或重挂载后，客户端请求 `GET /api/next-input.cached`；命中则不再调用模型。
5. **取消**：Tab/Enter 采纳或 Esc 会通过 `POST /api/next-input.dismiss` 写入 dismissed 墓碑，刷新后不会再次出现。

**路由选择**：客户端把会话当前选中的模型（`modelSelection` 投影，优先 `next`，其次 `lastUsed`）和最后一条回答自己的路由一起发给 Host。Host 依次取：设置页里保存的 provider/model、会话选中的模型（其 provider 仍已注册时）、最后一条回答的路由。响应里的 `route: { provider, model, source }` 中 `source` 为 `settings` / `session` / `answer`（选了模型但不可用时带 `fallback: true`）。预测调用不是 agent 自己的请求，不会改变会话的模型选择。

Host 缓存是进程内存，DSH/插件重启会清空。默认 `predictOnActivate: true`，打开会话会用一次模型调用补上缺失缓存；想省掉这次调用就把它关掉，等下一轮回答再生成。

## 配置参考

所有字段可选。profile 行 `config` 是基线，设置页把覆盖值写入插件设置文件。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxSuggestionChars` | `140` | 返回的建议最大长度。 |
| `maxContextChars` | `8000` | 送入预测的对话字符上限。 |
| `maxMessages` | `24` | 送入预测的对话条数上限。 |
| `maxTokens` | `512` | 预测调用输出上限。 |
| `timeoutMs` | `20000` | 单次预测墙钟上限。 |
| `enterToSend` | `true` | 普通 Enter 采纳并发送预测。 |
| `predictOnActivate` | `true` | 打开会话时补生成缺失预测。 |
| `predictionProvider` | `''` | 可选的固定预测 provider；必须和 model 同时设置。留空表示跟随会话选中的模型。 |
| `predictionModel` | `''` | 可选的固定预测 model；必须和 provider 同时设置。 |
| `maxMode` | `false` | Max 模式总开关。关闭时下面这些键一个都不会被读取。 |
| `includeToolActivity` | `true` | 带上最近一轮的工具调用。仅在 Max 模式下读取。 |
| `smartPack` | `true` | 打包时预留最早的提问。仅在 Max 模式下读取。 |
| `allowMultiline` | `true` | 保留换行；`maxSuggestionChars` 为默认值时把上限提到 `400`。仅在 Max 模式下读取。 |
| `reasoningEffort` | `'model'` | `model` / `low` / `medium` / `high`。仅在 Max 模式下读取。 |
| `retryOnFailure` | `true` | 在 `timeoutMs` 内退避重试一次。仅在 Max 模式下读取。 |
| `predictOnEndOnly` | `true` | 忽略 `predictOnActivate`。仅在 Max 模式下读取。 |
| `promptVariant` | `'next'` | `legacy` / `next`。仅在 Max 模式下读取。 |

两个枚举键会校验：未知的 `reasoningEffort` 或 `promptVariant` 会被设置路由拒绝，来自 profile `config` 行时直接忽略，而不是悄悄选中一个并不存在的模式。

## 加快预测

命中缓存是瞬时的；未命中时延迟主要来自模型调用。可以：

- 会话里的模型较慢时，在设置页固定一个更快的、非推理 provider/model。
- 降低 `maxTokens`（例如 `256`），必要时降低上下文字符/消息上限。
- 希望打开会话即有 ghost 就保持 `predictOnActivate` 开启；不想为预生成付费就关掉。Max 模式下的 `predictOnEndOnly` 起同样作用，不必动旧开关。
- 客户端在回合结束后会以较短延迟启动预测，并在事件窗口追上时短暂重试。
- Max 模式的 `reasoningEffort: 'model'` 可能让推理模型比原来“最低档”更慢；更在意延迟就固定 `low`。

## 隐私与费用

每完成一轮，最近的用户/助手文本会作为一次辅助请求发送给当前配置的模型提供商。Max 模式打开 `includeToolActivity` 时，还会额外发送最近一轮的工具调用摘要：命令行、文件路径和失败标记，**不包含工具输出的正文**。Host 会校验会话仍存在、provider 已注册。预测文本只存在于 Host 进程内存和可选的设置文件里；不会写入会话日志、磁盘缓存或 `localStorage`。设置文件只包含布尔值、数字、枚举值和 provider/model id，不包含凭据。

每次预测都会消耗 provider token。一个回答在一页里最多触发一次预测，同一会话最多一个在途请求：客户端把已预测过的回答记在 HTML 根节点上（刷新即清空，因为刷新前在途的预测无法回填）、在本页内记住已消耗过的回答，来自重挂载或激活查询的重复预测都会被拒绝；Host 在第一个 `session + answer` 请求还在流式返回时会拒绝重复请求。设置页的“用量”分区会显示实际开销。停用插件行或关闭 `predictOnActivate` 即可停止额外调用。

## 排查

- **切会话/刷新后没有 ghost**：Host 缓存可能为空（重启或插件重载）且 `predictOnActivate` 关闭；下一轮回答会重新填充。
- **composer 上方出现“预测: …”小 pill**：inline ghost 无法测量，pill 是 fallback；如果持续出现，请报告 composer/版本。
- **Enter 只填入不发送**：当前 composer 没有暴露 submit action，或草稿在提交前被改动；Tab 仍可填入，可手动发送。
- **设置页不出现**：安装/重载后刷新页面，再打开 设置 → 下一步输入。
- **始终没有预测**：确认输入框为空、会话空闲，且 `llm.listProviders()` 仍包含所选路由。
- **Max 模式像是没生效**：总开关关闭时子开关是锁定的。如果改的是 `smartPack` 或 `includeToolActivity`，需要刷新页面——这两项在 overlay 挂载时读一次。
- **Max 模式下预测还是单行**：`allowMultiline` 关着、`maxSuggestionChars` 被调到了默认值以下，或者模型自己选择了单行（这是允许的）。

## 已知限制

- ghost 依赖 composer 内部 DOM 标记（`data-composer-card`、`data-lexical-editor`、`data-composer-placeholder`）。UI 升级可能让 inline ghost 退化为 pill 或消失；目前没有公开的几何 API。
- Host 缓存是进程内存，DSH/插件重启会清空。
- 触发仍依赖 running 状态跳变；开始和结束发生在同一次渲染内、或回答结束时 overlay 未挂载，需要 `predictOnActivate` 或等下一轮。
- 没有组件级浏览器测试；已有路由、解析和设置路由测试。
- “当前模型”默认指会话里选中的模型，取不到时用最近回答的路由；只有在设置里固定了预测路由时才例外。
- 只读浏览器已加载的事件窗口。
- Max 模式的工具活动是**摘要**，不是工具输出：它报告跑了什么、哪一步失败了，不包含命令的 stdout 或 diff 正文，而且只覆盖最近一条回答所在的那一轮；更早的活动已经体现在助手说过的话里。
- 影响浏览器实际发送内容的两个开关（`smartPack`、`includeToolActivity`）只在挂载时读一次，改动后需要刷新页面；其余子项在下一次预测时生效。
- 设置页由插件自己实现，不是 schema 派生的 Plugin Manager 表单。
- 设置文件由整个 DSH 安装共享，不是 per-profile。

## 开发

```bash
npm test        # node --test：Host 路由、解析、Client 与语言测试
npm run check   # node --check host/client
```

文件：

- `src/index.js` — Host 路由、预测调用、缓存、设置文件。
- `src/client.js` — 输入框 ghost、按键处理、设置分区、locale。
- `cordis.patch.yml` — 插入 `next-input` 行。
- `locale/` — 只放 Plugin Manager 元信息（`meta.title` / `meta.description`，每种基线语言一个文件）。界面文案在 `src/client.js` 里。
- `test/` — Host 路由、解析、Client 注册测试。

## License

MIT
