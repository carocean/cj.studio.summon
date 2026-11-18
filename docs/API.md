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

## 跨主体发现 v0.7

`POST /v1/discovery`，认证方式不变。请求二选一：

```json
{"prompt":"你能做什么","context":{"zone":"demo-world","renderers":["capability-card"]}}
```

或用 `serviceId` 替代 prompt（如 `local.report`）。不能同时传两者。prompt 最长 4000 字符，zone 为非空字符串最长 200，renderers 最多 20 个非空字符串、每项最长 100。未知服务标识返回 404；不认识的自然语言返回 needs_clarification 而不执行代码/模糊猜测。

返回包含 `planner`（demo-rules/explicit-service）、`simulation:true`、`executed:false`、`status`（proposed/needs_choice/unavailable/needs_clarification）、`candidates` 和 `unavailable`。候选为 `{creatureId,name,service}`；不可用项额外包含 `reason`（outside_simulated_activity_space/renderer_unavailable）。只包含当前认证 owner 的 active 且挂载该能力的主体。不返回其他 owner 的主体；body ownerId 不改变认证身份。`service` 为同一公共服务目录的描述，包含输入名称、效果与 renderer。

这是只读发现，不自动执行、不创建会话。不因唯一匹配便取得执行许可；调用方明确选择后须另行 `POST /v1/invocations`，该入口重新检查所有边界。服务可能有必需输入，如 conversation 还需要该主体下已授权 sessionId 与 message。规划结果不是已完成回执。

验证示例（APP_TOKEN 由操作者安全设置，不写进文档）：

```sh
curl --fail-with-body -s http://127.0.0.1:8080/v1/discovery \
  -H "Authorization: Bearer $APP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"菜单","context":{"zone":"demo-restaurant","renderers":["menu-card"]}}'
```

菜单数据仍是演示夹具。全局发现当前尚未接入 Flutter 交互入口。

### v0.8 客户端接入

Flutter 全局呼唤页面现使用上述 discovery→用户选择→独立 invocation 流程。全局页面不调用 sessions API；只对能力自述、演示菜单和本地回执开放明确调用按钮。旧候选无权绕过后端撤权检查。此前 v0.7 “仅 API 入口”的限制不再适用于 v0.8。

## v0.9 历史会话及授权世代

- `GET /v1/creatures/:id/sessions` 返回 `{sessions:[{id,creatureId,turnCount}],maxTurns}`，仅当前认证 owner 的对应 active 主体可查询，按最后创建在前排列；不返回其他主体/所有者会话。读取消息仍用已授权的 `GET /v1/sessions/:id`。
- `POST /v1/sessions` 保留明确创建语义。Flutter 已提供会话历史/新建入口，满额会话可保留查看而另建会话。`resume` 仍只恢复最后创建会话，**不因满额自动新建**。历史不被轮换删除；1000 会话总容量与每会话 50 回合限制不变。
- 主体装配 UI 使用已有 kernel/state、subjects、mounts、transitions 接口；只开放 capabilities.describe/local.report 和暂停/恢复。创建不自动挂载服务。写入失败后必须先刷新核对，避免不确定结果被直接重复写入。
- 主体 `authorizationVersion`（旧数据默认 0）在每次服务挂载/撤销、生命周期变更时递增。Runtime 在模型请求前捕获版本，结果提交同时核验版本、当前能力/生命周期及会话长度；版本不同返回 409 authorization_changed，即使能力已重新授予也拒绝旧结果。没有实际撤销已经完成的外部模型请求。
- CompatibleProvider 将 `aibm.personality` 送入 system 提示作为表达偏好，明确不得覆盖只对话/不可声称工具动作的约束。已用本地测试验证请求内容，未验证真实模型对个性的遵循。

v0.6 草稿仅按主体的说明在 v0.9 扩展为 endpoint/令牌/主体/会话隔离；仍仅进程内，不上传、不落盘。

## v0.10 模拟连接租期

`POST /v1/kernel/connectors` 接受：

```json
{"subjectId":"<自有主体 ID>","kind":"device-simulation","status":"connected","leaseMs":30000}
```

- `kind` 可省略，仅支持 device-simulation；status 只能 connected/disconnected。leaseMs 为整数 1000–300000，默认 30000。接口不提供外部 URL、密钥或真实设备连接参数；不会进行网络配对或真实连接。
- 只有认证 owner 的 active 主体能写。服务端记 observedAt/expiresAt；客户端时间不是依据，重启不续期。disconnected 清除有效租期。此报告是模拟输入，不是受信任传感器证据。
- `GET /v1/kernel/state` 新增仅当前 owner 的 connectors。status 是最后报告状态，**effectiveStatus** 是当前有效状态：connected/disconnected/expired/subject_inactive。过期后保存的 connected 报告不得当作仍可达。
- 在主体明确挂载 `device.preview` 后，可用 `/v1/discovery` 的显式 serviceId 查询，再用 `/v1/invocations` 明确调用（context 仍需符合 AIBM，renderer 为 receipt-card）。新服务是 `demo:true` 的纯本地预检，结果明确 simulation=true、deviceActionExecuted=false。
- 发现和执行都重新检查服务、活动空间、呈现与当前连接租期；缺失/断开返回 409 connector_unavailable，过期返回 409 connector_expired。租期不授予服务权限，服务撤销仍返回 403 outside_service_boundary。
- device.preview 不在后台任务执行白名单；不能安排它定时或事件执行。Flutter 装配界面仍只允许原来的两个安全服务，不自动开放该测试能力。

目前每主体只有一个模拟连接；不包含真实设备发现、配对、凭证、网络控制、自动降级提醒或连接变化事件驱动。墙钟回拨可能延长绝对租期，此本地实验尚未实现可信时钟/分布式租约。未来真实执行必须重新设计可达性证据与动作时的安全校验，不能拿本地预检回执作外部动作授权。

## v0.11 失联事件、去重及过期锁存

连接报告沿用原接口。connected 租期首次被观察为过期，或从 connected 明确报告 disconnected，记录 `simulation.connector.lost`（cause 为 lease_expired/explicit_disconnect），并将既有 `trigger:{kind:"event",type:"connector.lost"}` 任务加入待运行状态。后台执行白名单仍只有 local.report；事件本身不创建任务、不发消息、不调用模型或硬件。

```json
{"subjectId":"<自有主体 ID>","serviceId":"local.report","trigger":{"kind":"event","type":"connector.lost"},"payload":{"purpose":"本地失联回执，不是已发出的提醒"}}
```

用原 `/v1/kernel/tasks` 明确安排上述任务。未安排就不执行；暂停主体保留待运行状态直到恢复，撤销能力/取消任务不因失联而复活。repeat 任务仍受原 minimumIntervalMs 限频与队列合并，多个失联可以合并为一个本地回执，不保证逐个通知。连接恢复不撤销已排入的回执，因为它描述已经发生过的失联。

每段连接记录包含持久 `lossEmitted`、观察失联时的 `lossObservedAt`。已观察失联是旧租约的终态，重启/时钟回拨不会清除。新 connected 上报代表新的显式模拟证据，建立新租约。到期前续租不产生失联；到期后才续租会先保存中间的失联事实，再建立新租约。

**查询副作用说明修正：** connectorStatus、主体目录/内核状态查询或服务发现观察到过期时，会保存终态并排队已有的本地降级任务。它们不创建新任务、不执行外部服务，但不再是绝对零写入的查询。正常后台 tick 也会独立观察并处理到期，用户无需不断打开页面。标记、排队与后续本地回执仍以单进程原子快照保存。

仅锁存**已观察**过期。进程关闭期间实际经过多久、启动前从未观察到的墙钟回拨没有可信证据，仍无法完全判定；没有跨机器/断电耐久/单调时间保证。计时回拨还可能延后已有任务的到期/限频时刻。本功能不构成真实提醒投递或设备安全保障。

## v0.12 主体创建与任务安排的持久请求标识

`POST /v1/kernel/subjects` 和 `POST /v1/kernel/tasks` 可在原 JSON 对象加入 `requestId`：8–128 位 ASCII 字母、数字、下划线或连字符。不传仍保留原来每次新建的兼容语义；无效标识返回 400 invalid_request_id。

同一认证 owner 的 requestId 是跨这两个操作共享的命名空间。系统将操作类型及规范化参数生成 SHA-256 指纹，结果和请求记录随实际写入同一原子快照保存。再次提交同标识/同有效参数，返回原结果及 `requestId,replayed:true`，不重新写入；首次成功带 replayed:false。更改参数或操作则 409 request_id_conflict。对象属性顺序不影响指纹，数组顺序仍有意义。不同 owner 同标识互不引用；body ownerId 不能改变身份。

返回是**原始成功回执，不是实时状态**：已取消任务的重试不会复活任务，已暂停主体也不会恢复。请读取 kernel/state 核对当前状态。即使原服务能力后来撤销，重放仅取原回执，不授予任何新权限或重新执行。新请求仍检查当前能力、生命周期及资源容量。

失败事务不消耗请求标识。请求记录全局最多 1000 条，达到上限新记录返回 429 request_capacity，既有同标识重试仍可用。没有自动过期/清理，避免在不知情时破坏重试保证。内部账本不通过 kernel/state 暴露；数据库/运行文件不应提交仓库。

Flutter 创建主体使用安全随机 128 位标识，参数不变的未确认重试复用标识；页面关闭或 App 重启不持久保存客户端待确认请求，仍需手动核对已创建主体。接口无自动网络重试，模型对话、连接报告、服务调用及其他写入尚未接入该机制。单进程原子快照不等于断电/分布式/外部系统 exactly-once。

## v0.13 请求账本的 owner 配额

新增默认每 owner 100 条幂等成功回执配额，主体创建与任务安排共用。全局 1000 条上限不变。新请求超过个人额度返回 429 owner_request_capacity；全局满额仍为 429 request_capacity。既有同标识重试在配额检查前读取原回执，即使个人/全局额度已满也不受影响，不发生新写入。

`GET /v1/kernel/state` 新增 `requestQuota:{used,limit}`，只表示当前认证 owner 的账本使用量和个人上限。调用方的 ownerId 字段不能切换统计或额度身份。

v0.12 旧记录的归属由已有 result.ownerId 兼容恢复；不丢弃、不重新创建已成功请求。旧记录即使已经超过新个人上限仍可重试，但不再接纳该 owner 的新记录；升级不会自动回收或腾出已用全局容量。无可恢复归属的遗留记录仍占全局上限，不猜测归属或跨 owner 展示。

内核构造参数 maxRequestsPerOwner 可由可信部署者设置为 1–1000 的整数，缺省 100；没有修改配额的 HTTP 接口，也不接受客户端参数覆盖。提高上限会相应削弱个人隔离，生产多租户策略尚未完成。

未携带 requestId 的旧接口仍不消耗该账本，但受原主体/任务容量限制；因此该改动只防止单 owner 在默认配置下独占**幂等账本**，不解决所有共享资源或身份创建滥用问题。

## v0.14 相对延时与任务客户端

`POST /v1/kernel/tasks` 的 timer trigger 新增可选 `delayMs`（1000–86400000 的整数），与 `at` 二选一；同时传入返回 400 ambiguous_timer。已有绝对 at 与周期 intervalMs 行为保留。示例：

```json
{"subjectId":"<主体 ID>","serviceId":"local.report","requestId":"unique-task-request","trigger":{"kind":"timer","delayMs":60000},"payload":{"purpose":"一分钟后的本地回执"}}
```

幂等指纹绑定相对延时意图，而非每次请求时的当前时间；首次实际创建时才用服务端时钟计算绝对 at，返回任务存储的 trigger.at/dueAt。重试或重启后回放同一 requestId 不重新计算、不顺延、不重新执行。超出有效整型时间范围拒绝，不保存坏任务。

Flutter 通过主体装配页进入 TasksPage，仅对活跃且挂载 local.report 的主体开放新安排。界面只提供一次延时或一次 connector.lost 等待，不提供周期广播/模型/设备执行。原有 kernel/state、cancellations 接口用于手动刷新和明确取消；取消失败或写入结果不确定时必须先刷新核对，旧回执保留。

任务创建使用页面内安全随机 requestId；参数不变的重试复用标识。页面关闭后该待确认标识不自动恢复，需核对已有任务。服务端持续执行不依赖手机页面，**但依赖服务进程存活**。回执只表示本地执行结果，不代表通知送达。失联等待只消费安排后观察的事件，不回放已处理的历史失联。

## v0.15 感知与按需输入

感知接口、权限及媒体/元数据保留策略见 [PERCEPTION](PERCEPTION.md)。感知媒体走单独有限大小入口，不可通过普通服务调用伪造感知回执。
