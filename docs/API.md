# API v0.1

除 `/health` 外需要 `Authorization: Bearer <APP_TOKEN>`。Content-Type 为 application/json。

- `GET /health`：健康与运行模式。
- `GET /v1/creatures`：主体列表及模式。
- `POST /v1/sessions`，`{"creatureId":"companion"}`：201，创建独立会话。
- `GET /v1/sessions/:id`：读取会话及消息。
- `POST /v1/sessions/:id/calls`，`{"message":"你好"}`：追加一次成功对话回合。

失败格式 `{"error":"code"}`。401 未授权，404 资源不存在，400 输入错误，409 当前会话正在调用，413 请求过大，429 容量/回合数超限，502 供应商失败。供应商错误不暴露密钥或内部错误文本，失败回合不写入历史。

调用当前没有幂等键。若网络在服务完成后中断，客户端应先 GET 会话核对，再决定是否重试。自动安全重试将在后续能力实现。

## 服务调度 v0.2

- `GET /v1/creatures/:id/services`：只返回主体 AIBM 已授权的服务描述。
- `POST /v1/plans`，`{"creatureId":"restaurant","prompt":"你能做什么"}`：返回 proposed 或 needs_clarification；planner 明确为 demo-rules，不执行服务。
- `POST /v1/invocations`：`{"creatureId":"restaurant","serviceId":"capabilities.describe","arguments":{},"context":{"zone":"demo-restaurant","renderers":["capability-card"]}}`，返回结构化呈现结果。

`context` 当前是模拟输入，绝不可用于生产地理授权。实际服务边界来自服务端固定 AIBM。菜单/预览是演示 fixture；只有能力自述实际查询当前运行时的注册数据。调用不存在的 order.submit 会被拒绝。
