# 更新日志

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
