# dsh-next-input

[English](README.md) | 中文

一个 DeepSeek Harness（DSH）Web 输入框插件。DSH 回答结束后，它会用当前模型预测你下一句可能输入的内容，以浅色“幽灵文字”预填在空输入框中；按 **Tab** 即可采纳。

## 功能

- 在一轮回答结束、会话空闲时读取最近的用户/助手文本。
- 只取已加载事件窗口中的文本，不读思考过程、工具参数或注入上下文。
- 默认跟随当前对话中选中的模型（取不到时用产生最近一条回答的模型），也可以在设置里固定一个更快的预测路由。
- Host 按 `sessionId + answerKey` 缓存预测；切会话、overlay 重挂载、刷新页面后可以恢复。
- 只有草稿为空、会话空闲时显示 ghost。
- 按 Tab 采纳；默认开启“普通 Enter 采纳并发送”。
- 不把对话写入预测缓存、会话日志或 `localStorage`。

## 环境要求

- DSH Web UI，且存在 `conversation.input.overlay`、`settings.plugins.tab` 和 `settings.section` 插槽。
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

打开 **设置 → NextInput**（设置侧栏里以插件名命名的一级入口）；同一个页面也出现在 **设置 → 插件 → NextInput**。可以调整：

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

- **保存** 立即应用到下一次预测；不会重载插件，也不会清空 Host 预测缓存。
- 配置保存在插件的用户数据文件：
  `<DSH_HOME>/next-input/settings.json`（通常是
  `~/.dsh/next-input/settings.json`）。
- `cordis.patch.yml` 里该行的 `config` 仍然作为基线；**重置为 profile 默认值** 会删除设置文件并回退到基线。
- provider/model 下拉通过 `llm.listProviders()` 和 `llm.listModels()` 填充；已经不在目录里的旧值会作为 `(unavailable)` 选项保留。
- 想恢复“跟随当前对话的模型”，在 provider 下拉里选回这一项即可，它会同时清空两个字段。

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

## 加快预测

命中缓存是瞬时的；未命中时延迟主要来自模型调用。可以：

- 会话里的模型较慢时，在设置页固定一个更快的、非推理 provider/model。
- 降低 `maxTokens`（例如 `256`），必要时降低上下文字符/消息上限。
- 希望打开会话即有 ghost 就保持 `predictOnActivate` 开启；不想为预生成付费就关掉。
- 客户端在回合结束后会以较短延迟启动预测，并在事件窗口追上时短暂重试。

## 隐私与费用

每完成一轮，最近的用户/助手文本会作为一次辅助请求发送给当前配置的模型提供商。Host 会校验会话仍存在、provider 已注册。预测文本只存在于 Host 进程内存和可选的设置文件里；不会写入会话日志、磁盘缓存或 `localStorage`。设置文件只包含布尔值、数字和 provider/model id，不包含凭据。

每次预测都会消耗 provider token。停用插件行或关闭 `predictOnActivate` 即可停止额外调用。

## 排查

- **切会话/刷新后没有 ghost**：Host 缓存可能为空（重启或插件重载）且 `predictOnActivate` 关闭；下一轮回答会重新填充。
- **composer 上方出现“预测: …”小 pill**：inline ghost 无法测量，pill 是 fallback；如果持续出现，请报告 composer/版本。
- **Enter 只填入不发送**：当前 composer 没有暴露 submit action，或草稿在提交前被改动；Tab 仍可填入，可手动发送。
- **设置页不出现**：安装/重载后刷新页面，再打开 设置 → NextInput 或 设置 → 插件。
- **始终没有预测**：确认输入框为空、会话空闲，且 `llm.listProviders()` 仍包含所选路由。

## 已知限制

- ghost 依赖 composer 内部 DOM 标记（`data-composer-card`、`data-lexical-editor`、`data-composer-placeholder`）。UI 升级可能让 inline ghost 退化为 pill 或消失；目前没有公开的几何 API。
- Host 缓存是进程内存，DSH/插件重启会清空。
- 触发仍依赖 running 状态跳变；开始和结束发生在同一次渲染内、或回答结束时 overlay 未挂载，需要 `predictOnActivate` 或等下一轮。
- 没有组件级浏览器测试；已有路由、解析和设置路由测试。
- “当前模型”默认指会话里选中的模型，取不到时用最近回答的路由；只有在设置里固定了预测路由时才例外。
- 只读浏览器已加载的事件窗口。
- 设置页由插件自己实现，不是 schema 派生的 Plugin Manager 表单。
- 设置文件由整个 DSH 安装共享，不是 per-profile。

## 开发

```bash
npm test        # 28 个测试
npm run check   # node --check host/client
```

文件：

- `src/index.js` — Host 路由、预测调用、缓存、设置文件。
- `src/client.js` — 输入框 ghost、按键处理、设置页、locale。
- `cordis.patch.yml` — 插入 `next-input` 行。
- `locale/` — Plugin Manager 元数据和客户端文案。
- `test/` — Host 路由、解析、Client 注册测试。

## License

MIT
