# 更新日志

## 0.5.0

- 插件正式更名为 **下一步输入**（英文 **Next input**）：插件列表标题、设置侧栏入口、页面标题和导航图标名称统一使用这个名称。
- 移除 **设置 → 内置插件** 下的标签页。设置页只保留在插件自己的一级分区 **设置 → 下一步输入**，分区顺序与其他插件分区一致；操作栏不再沿用标签页布局里铺在面板底色上的样式。

## 0.4.0

- 设置页新增“用量（本次 Host 运行）”分区：预测调用次数、来自 provider `usage` 的输入/输出/总计 token、平均每次、命中缓存的输入、缓存命中次数、被拒绝的重复请求，以及“重置计数”；同一数据也可通过 `GET /api/next-input.usage` 获取。
- 同一个回答不会再重复消耗 token：overlay 把已预测的回答记在 HTML 根节点上（重挂载不丢、刷新清空），重挂载和激活查询都不会再次预测；Host 在首个 `session + answer` 请求在途时拒绝重复请求。
- 在途守卫提前到第一个 `await` 之前登记，第一个请求还在准备时到达的重复请求也无法再漏过去。
- 30 个测试覆盖路由、设置、路由选择、用量、解析和 Client 注册。

## 0.3.0

- `enterToSend` 与 `predictOnActivate` 默认改为 `true`；仍可在设置页或 profile 行 `config` 里关闭。
- 预测路由默认跟随当前对话选中的模型：客户端读取会话的 `modelSelection` 投影并随每次预测发送；Host 依次取设置里的固定路由、会话选中的模型、最后一条回答的路由，并返回 `route: { provider, model, source }`。
- 设置页改名为 **NextInput**，并在设置侧栏新增同名一级入口（带导航图标）；**设置 → 插件** 下的 Tab 仍然是同一个页面。
- provider 下拉的自动项改为“跟随当前对话的模型”，选中时会同时清空两个路由字段。
- 修复“保存”按钮看不清的问题：主按钮改用 Host 的 `button-primary-fill` / `label-primary-foreground` 配对（浅色主题下深色底、浅色字），不再在 `brand-primary` 上放白字（浅色主题下 `brand-primary` 是深色文字色）。操作栏固定在分区底部，按钮加高，次要按钮样式也做了区分。
- 28 个测试覆盖路由、设置、路由选择、解析和 Client 注册。

## 0.2.0

- Host 侧按 `sessionId + answerKey` 缓存预测，支持 dismissed 墓碑；切会话、刷新页面、换端口后可恢复。
- 新增 Settings → Plugins → “下一步输入” 设置页：开关、数字字段，以及从 `llm.listProviders()` / `llm.listModels()` 填充的 provider/model 下拉。
- 插件自有设置文件，保存立即生效；profile 行 `config` 作为基线，“重置为 profile 默认值” 会删除设置文件。
- 支持可选的更快预测路由、最低 reasoning effort、`max-tokens` 处理和部分建议。
- Tab 采纳优先使用 `insertText`（可撤销），失败回退 `setDraft`；可选 Enter 采纳并发送。
- Host 校验 Session/provider，限制同一会话 in-flight 请求，客户端增加超时，对话以 JSON 不可信数据传入，错误响应收敛。
- ghost 测量重试、placeholder 定位、fallback pill，处理 RTL 和主题 token。
- 23 个测试覆盖路由、设置、解析和 Client 注册。

## 0.1.0

- 初始 Web 输入框预测插件，支持 Tab 采纳。
