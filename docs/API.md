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

## 持久内核 v0.3

以下均为开发令牌鉴权、单所有者、本地无外部副作用接口：

- `GET /v1/kernel/state`：持久主体、任务、回执。
- `POST /v1/kernel/subjects`：`{"name":"固定主体","activitySpace":"fixed-simulation"}`。
- `POST /v1/kernel/mounts`：`{"subjectId":"...","serviceId":"local.report","enabled":true}`；仅白名单纯本地执行器。
- `POST /v1/kernel/transitions`：`{"subjectId":"...","status":"paused"}`；状态为 active / paused / retired，退役不可恢复。
- `POST /v1/kernel/tasks`：`{"subjectId":"...","serviceId":"local.report","trigger":{"kind":"timer","at":<epoch-ms>,"intervalMs":60000},"payload":{"purpose":"本地回执"}}`。
- 事件任务 trigger 可为 `{"kind":"event","type":"destination.approaching","repeat":false}`。
- `POST /v1/kernel/signals`：`{"subjectId":"...","type":"destination.approaching"}`，明确模拟信号。
- `POST /v1/kernel/cancellations`：`{"taskId":"..."}`。

服务进程定时调用内核 tick，没有公开任意执行接口。默认周期不得少于 60 秒，可设更严格 minimumIntervalMs。撤销能力会取消未完成任务；暂停保留任务但不执行；单次任务完成后重复事件不再次执行。持续事件任务合并待执行信号，并限制最小间隔。
