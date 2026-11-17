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

## v0.4 统一说明

生产 `/v1/creatures` 的 ID 与 `/v1/kernel/state` 主体 ID 相同，实际 ID 是生成的 UUID，不应硬编码 companion 等模板名。首次启动种入模板一次。通过 kernel/subjects 创建并 mounts 挂载的主体马上可被服务发现/计划/会话调用使用。会话按 ID GET 可在后端重启后恢复。

主体暂停时不能新建会话或执行服务；历史会话仍可由所有者只读访问。撤销 conversation 后，即便已有会话也不能调用；请求正在等待模型时被撤权，返回结果不提交。

## 会话恢复 v0.6

`POST /v1/sessions/resume`，`{"creatureId":"<持久主体 ID>"}` 返回 200 和 `{id, creatureId, turns}`。按服务端认证 owner 与主体选择最后创建的现有会话；没有时才创建，重复恢复不占新配额。校验主体归属及 active 状态。不能通过 body ownerId 冒充其他用户。旧创建接口仍明确创建新会话，不改变已有语义。

恢复不绕过能力授权、50 回合或全局 1000 会话上限，不自动清空满额会话。当前客户端尚无多会话选择/新会话管理 UI。后台仍是单开发令牌映射一个 owner，不冒充生产多账号登录。

客户端同主体点击不请求；切回主体、断开后连接并选择主体，从后端恢复消息（服务重启亦有效）。未发送草稿仅保留在当前应用进程内，按规范化 endpoint、令牌与主体隔离；切换服务/令牌会清空草稿，断开会隐藏并清空可见输入。草稿不上传、不落盘，应用重启不恢复草稿。旧聊天历史不会离线缓存显示。长对话发送成功自动滚动到底部。
