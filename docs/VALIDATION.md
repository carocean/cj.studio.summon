# Validation record

## v0.5 environment

- Flutter 3.50.0 stable, framework revision `ab2912035e160d9cad6306df307576da6128ebdb` from the official Flutter GitHub repository.
- Dart 3.14.0; current official `material_ui` 1.11.1, dependencies recorded in `app/pubspec.lock`.
- Node.js v24.22.1.
- Local SDK/cache were kept outside the project and are not committed. No real model key or paid API was used.

## Scope distinctions

1. Flutter static analysis and widget tests check real Dart code, not a static HTML substitute.
2. Flutter web release build proves compilation for web, not APK/IPA installation or phone operation.
3. Dart → actual local Node API test exercises client JSON/HTTP and persistent backend together; model responses remain explicitly demo.
4. Backend → local HTTPS Chat Completions compatible mock test uses native fetch and TLS with an ephemeral test CA trusted only by its child process. It verifies request path, headers, model/messages, response parsing and returned conversation result. It does **not** verify any external vendor or model inference.
5. Android/iOS platform source generation is not compilation; no device, emulator or App Store upload has been performed.

The TLS test requires OpenSSL in PATH. Temporary test certificates and synthetic tokens are removed after tests. No global TLS verification switch is disabled.

## Executed final checks (2026-11-17)

- `flutter analyze`: passed, no issues.
- `flutter test`: passed, 9 tests, including real Dart client → Node process integration.
- `flutter build web --release`: passed; compiled `build/web` output is reproducible and excluded from source control.
- `npm test` in server: passed, 23 tests.
- `flutter doctor -v`: not an all-green environment. Android SDK is absent; Linux desktop toolchain is incomplete; Chrome needs explicit executable selection in this environment; its proxy-interface diagnostic crashed. These do not invalidate the above checks, but native builds and interactive browser QA are not claimed.

No testing server or mock provider was left running. Android/iOS generated default icons remain placeholders rather than final product branding.

## v0.6 session recovery regression (2026-11-17)

- Flutter analyze: no issues; Flutter tests: 11 passing (API, widget and actual HTTP).
- Node tests: 24 passing. Durable resume tested after reopening the store, repeatedly at session capacity, with owner/lifecycle rejection and immutable returned history.
- The real Dart→Node test now terminates and restarts the Node process on the same store, re-discovers the session by creature, and verifies identical ID and saved turns. This is real local persistence, still demo model output.
- Widget regressions cover already-selected no-op, A→B→A, draft preservation, disconnect/reconnect, changed-token draft isolation, and a 30-message newest-reply visibility check. The bounded conversation scroll body lays out all turns so scroll extent is exact.
- Web release compiled again. Native packaging and visual browser QA remain unverified. No real model or paid service used.
- Known limits: drafts are process-memory only; no multi-session UI/automatic rotation for the 50-round limit; connection ambiguity still requires checking saved history before resending a potentially committed call.

## v0.7 owner-scoped cross-subject service discovery (2026-11-17)

- `npm test`: 28 passing. Four new scenarios cover registry discovery without preselected subject, active/owner/capability/spatial/rendering boundaries, dynamic grants/revocation/retirement, invalid and unknown requests, and a real authenticated HTTP discovery→explicit selection→invocation sequence.
- Discovery is asserted not to mutate the persistent snapshot or invoke a model. A proposal obtained before capability revocation cannot bypass invocation checks.
- `flutter analyze`: no issues; `flutter test`: 11 passing. The existing real Dart client→Node restart test now also invokes global discovery and verifies multiple choices include the persisted subject.
- Client production source and platform shells are unchanged from v0.6; Web release was not rebuilt in this backend-focused iteration. The previously verified v0.6 client remains the current UI version. Global discovery is not yet a Flutter screen.
- No external model, paid API, third-party service market, physical location, hardware connector or real-world action was used. Native/visual browser verification remains open.

## v0.8 Flutter global calling entry (2026-11-17)

- `flutter analyze`: no issues; `flutter test`: 18 passed; `flutter build web --release`: passed (0.8.0+8).
- Six dedicated discovery widget scenarios verify discover/select without execution, explicit selected invocation, edited prompt invalidating candidates, failed rediscovery, revoked stale proposal, unavailable/unknown intent, duplicate pending requests/disposal, and narrow 320×568 menu/space presentation (some scenarios cover multiple checks).
- A navigation regression verifies entering/leaving global discovery preserves the chat subject, persisted history and private draft without creating another session or sending a conversation message.
- The real Dart→Node test now also selects a discovery candidate, invokes its service, revokes the grant using the test kernel API and verifies the old selection receives `outside_service_boundary`. The fixture then restores the grant and completes existing checks. This is actual loopback HTTP, not a widget mock, but not a real device or model.
- `npm test`: 28 passed; backend behavior remains unchanged in this client-focused iteration.
- Browser screenshot/interactive visual QA and Android/iOS builds remain unverified. Widget tests and web compilation are not substitutes for those stages. No paid API, real model, physical location, external order or device action was used.

## v0.9 lifecycle surface and independent-review repairs (2026-11-17)

- Reproduced all three review findings before fixing: resuming a full session left no client-side escape, revoke→regrant accepted an earlier pending model result, and AIBM personality was absent from provider requests.
- Added explicit session history/new-session UI rather than automatic rotation: full sessions retain history and owner isolation; new sessions remain subject to global capacity. Backend regression uses maxTurns=1 to exercise the same limit without 50 model calls. Flutter regression verifies full-session error→explicit new session→old history, with per-session drafts kept separate.
- Added persistent authorization generations. Revoke/regrant and pause/resume both reject pending output with `authorization_changed`; generation and old session history survive store restart. A fresh authorized request still succeeds. Plain revoke still rejects via the existing service boundary.
- Added a synthetic compatible-provider request assertion for AIBM personality and the no-real-action constraint. This verifies transmitted configuration, not real LLM obedience.
- New subject management widget checks creation without implicit services, explicit mounting, pause/resume, revoke confirmation/cancel, uncertain-write gating until refresh, read-only retired subjects, small viewport and disposal during loading. A navigation regression verifies returning after pause removes the stale active chat controls.
- Real Dart→Node HTTP now creates a subject, mounts local.report, pauses it, restarts the server, verifies preserved identity/ability/status, resumes it and invokes the local-only receipt. Session listing/new creation/old history retrieval are also exercised over actual HTTP.
- Final checks: Node 31 tests passed; Flutter analyze no issues; Flutter 25 tests passed; Flutter Web release compiled, version 0.9.0+9 verified. Existing tools/permissions were used; no denied check was bypassed.
- No native/device/interactive browser visual verification or real paid model execution. No third-party service execution or automatic service generation added.
- Public-source hygiene check found no tracked private chat URLs, real provider-key patterns, private-key blocks, personal email matches, .env, certificate/private-key files, original PDFs or runtime stores. Synthetic test tokens and temporary test TLS material are not real credentials; runtime data/build outputs remain excluded. This is a scoped check, not a comprehensive secret-scanner certification.

## v0.10 bounded simulated connector leases (2026-11-17)

- Node 35 tests passed. New fake-clock tests cover missing connection, valid lease, exact expiry boundary, restart without renewal, explicit disconnect after discovery, stale-candidate rejection, owner isolation, lease/kind validation, lifecycle checks, read-only status computation and missing-expiry fail-closed behavior.
- A connector lease does not mount/grant a service. Revoked service and background scheduling remain rejected even when a connector is marked available. Every successful device.preview result explicitly records no device action.
- Actual Node HTTP checks authentication and owner-body spoof rejection. The real Dart client test now traverses missing connection→explicit simulation report→local preview→disconnect→rejected preview over loopback HTTP.
- Flutter analyze: no issues; Flutter tests: 25 passed. Production Flutter UI is unchanged from v0.9; no new Web build in this backend-only iteration, and no connector UI is claimed.
- Source remains public-safe: no live credentials, private source PDFs, runtime databases or user private messages added. Connector state is test/runtime data excluded from version control.
- Not verified or implemented: real hardware/network connectors, external commands, trusted sensor evidence, automatic fallback notifications, monotonic/distributed leases, native builds or interactive browser visual QA. Wall-clock rollback remains an explicit limitation of the simulation.

## v0.11 loss-event fallback and observed-expiry repair (2026-11-17)

- Node 41 tests passed. Added expiry/disconnect event tests for exactly one observed loss per lease, repeated reads/ticks/restarts, timely renewal, renewal after expiry, recurring task cooldown/coalescing, paused/resumed subjects, revoked/cancelled/absent tasks and owner isolation. No automatic task creation or external reminder occurs.
- Reproduced the independent-review clock rollback issue in the previous comparison-only design. The repair persists observed expiry as a terminal fact. Tests expire a lease, observe it through status or state listing, roll the clock backwards, restart, reject invocation, and permit reacquisition only after a new explicit connection report.
- Observation uses a single clock sample so it cannot report an expiry discovered between two reads without recording that fact. A query that first observes expiry now performs internal state bookkeeping and may queue an existing authorized local fallback; this explicitly supersedes v0.10's zero-write status-check statement.
- Real child-server integration waits for the background interval by polling the persisted file, not by calling state/tick/signal endpoints. It verifies a prearranged local fallback result appears independently, then restarts and verifies there is no duplicate receipt.
- Flutter analyze no issues; Flutter 25 tests passed against the updated backend. Production UI remains v0.9; no new Web compilation or hardware/browser/native validation this iteration.
- Limits remain: unobserved time passage/rollback during process absence cannot be inferred reliably; there is no fully trusted monotonic clock, distributed lease or real device guarantee. Rollback can delay future task scheduling/cooldowns. No paid model, user notification or external control was used.

## v0.12 durable request identity for local creation (2026-11-17)

- Node 45 tests passed. New coverage verifies successful creation+receipt atomic snapshot, replay after restart without an extra write/object, response immutability, independent owner namespaces, changed-parameter/operation conflict, canonical object-key ordering, failed transactions not consuming IDs, and ledger capacity rejecting new records while accepting existing replays.
- Cancelled-task replay returns only the original receipt and never revives execution or grants a service. Receipt metadata is not a live-state assertion; current state is checked independently.
- Real concurrent HTTP retries for subjects and tasks create one object each; authentication and body-owner spoofing remain enforced. The real Dart→Node restart test now repeats the original creation request and verifies the original ID with replayed=true while the actual subject remains paused.
- Flutter 26 tests passed; analyze no issues. New widget test simulates a successful server-side creation followed by a lost response, refreshes the observed state and retries with the exact same secure-random request ID, without a duplicate subject. Existing lifecycle/authorization/session/discovery regressions continue to pass.
- Flutter Web release compiled; version 0.12.0+12 verified. No native builds, physical-device testing or interactive browser visual verification claimed.
- Limits: request IDs are optional for legacy API callers; supported only for subject creation and task scheduling; global receipt cap is 1000 with no silent eviction. Client pending identity lives only in the current creation page. No automatic network retries, external exactly-once guarantee, distributed writer support or power-loss durability added.
- Public-source pattern check again found no private chat links, real key patterns/private-key blocks or personal email matches in tracked source; no private input artifacts were added.

## v0.13 per-owner request-ledger quota (2026-11-17)

- Node 48 tests passed. New checks cover a shared subject/task owner quota, an owner reaching its limit while another owner can still create, replay after quota exhaustion/restart, v0.12 receipt-owner migration, preexisting receipts above a lowered limit, and invalid configuration rejection before taking a store lock.
- Real authenticated HTTP checks enforce owner_request_capacity even if the request body supplies another owner, and expose only the authenticated owner's used/limit. Existing concurrent same-ID retries remain one committed operation.
- Flutter analyze: no issues; Flutter 26 tests passed against the updated backend. Production Flutter source remains v0.12, so no new Web build was performed for this backend-only change.
- Default owner limit is 100 receipts; global 1000 cap and no-silent-eviction policy remain. Old over-limit records remain replayable; old globally full stores do not magically regain space. No user data or idempotency evidence was deleted.
- Scope is intentionally narrow: shared subject/task/session budgets, multiple-owner global exhaustion, rate/fairness controls and production identity management remain open. This is not a complete multi-tenant isolation claim.

## v0.14 usable local task lifecycle (2026-11-17)

- Node 49 tests passed. Relative timer tests verify a server-clock deadline, replay after time advances/restart without postponement, exact due-time execution, invalid/both timer fields and bounded delay validation. Existing authorization, pause/revoke/cancel, connector fallback and quota suites remain passing.
- Flutter analyze: no issues; Flutter 32 tests passed. Six task widget scenarios cover explicit safe scheduling, refreshed receipts, lost-response ID reuse, confirmation/cancel, revoked capability, invalid delay, future-event warnings, subject filtering, narrow viewport, large timestamp rendering and entry/return through subject assembly (some scenarios combine checks).
- Actual Dart→Node HTTP now schedules a relative timer with a request ID, restarts the server, replays the same request with identical task ID/deadline and cancels it. This exercises transport/persistence; relative completion timing uses the deterministic backend clock test, not a claimed physical-device run.
- Web release compiled and version 0.14.0+14 verified. Generated output is excluded from source control. No native build or interactive browser/device visual verification claimed.
- Task page manually refreshes; it does not subscribe to push events or deliver notifications. It can create only one-shot local.report work, not broadcasts, model calls or device actions. Background execution requires the service process to remain running; paused subjects and cancelled/revoked tasks retain kernel semantics.
- Lost-response reconciliation retains an ID only within the current page. Closing the page loses pending client identity, so users must inspect existing tasks before recreating an uncertain request. No extra privacy-bearing source artifacts or credentials added.

## v0.15 感知主入口

- 全量 Node 57/57 通过，包含两项 opt-in 的真实 Tesseract/Vosk→实际鉴权 HTTP→主体元数据事件测试，不是处理器 mock。普通 `npm test` 未配置本地模型/样本时明确跳过这两项。
- Python 处理器 5/5 通过，覆盖真实英文 OCR、真实中文 WAV 转写、静音、错误格式、尺寸/路径/语种限制。中文模型 `vosk-model-small-cn-0.22`，语音识别样例非仓库资产；模型、外部样本均不提交。
- Flutter analyze 无问题，42/42 全量测试通过，包括感知9项、周期 dueAt 显示修复、旧会话/服务/任务回归。设备采集测试使用替身，不等同手机硬件。
- Flutter Web release 最终代码编译通过；没有 Android/iOS 构建或真机/浏览器视觉验收。
- 感知测试覆盖授权撤销再授予、处理前/后权限变化、关闭取消、临时文件清理、重启中断、主体隔离和非可信图像文字不能开启文字输入。没有支付、外部API或通用视觉模型调用。

## v0.16 OpenPorts 只读桥与感知契约修复

全量 Node 62/62 通过，包含真实 Java OpenPorts 进程经 AIOS 鉴权 HTTP 的只读 Hello 调用，以及 v0.15 真实 OCR/中文ASR回归，未跳过。Java实例来自独立临时runtime副本，JDK8，结束后已停进程；未改框架源。协议替身测试覆盖坏响应、超限、超时、重定向拒绝和授权撤销再授予。

修正公共 capabilities 不再广告处理CLI支持但 HTTP不接收的 WebM/Ogg等格式；明确仅WAV/PNG/JPEG并新增回归。部署说明和未集成范围见 ECM-BRIDGE.md。

Flutter analyze 无问题、全量42/42测试通过。v0.16没有改Flutter执行代码，未重新构建Web；最近Web release为v0.15成功结果。仍未真机或原生构建验收。

## v0.17 实验验证

Node最终68/68通过，包含真实Vosk中文转写→主体演示对话、真实OCR及Java OpenPorts回归。真实LLM未调用；结构化情境呈现用CompatibleProvider的契约替身验证，拒绝不合法/可执行组件且不保存失败回合。撤销再授权、服务关闭中的响应不能提交。桥凭据回显拒绝及并发上限/释放均覆盖。

本轮只是实验原型；生成式OS/GeoOS/AI生物的统一微内核设计尚未完成，不能用这些测试声称系统目标已实现。

最终 Flutter analyze 无问题，44/44全量测试通过，Web release最终代码编译通过。未做手机真机或Android/iOS原生构建，未调用外部真实LLM。

## Microkernel lab foundations 0.1

Node24.22.1本机node:sqlite可用；新目录独立运行11/11基础测试通过。覆盖C1歧义值/非法输入/快照不可变、宿主句柄不可伪造及撤销、单写锁、版本/CAS、原子command与重放、事务结束后句柄失效、异步/嵌套事务拒绝，以及实际子进程SIGKILL在提交前回滚和提交后完整恢复。

没有实现或验证完整委托/信息流/执行出口；没有电源故障、真实外部写动作或生产认证保证。四份ADR是限定范围的技术决定，不代表所有计划机制已实现。

基础模块预提交复查修复了悬空符号链接绕过锁与async回调迟到拒绝未处理的问题；新增数据/锁路径悬空链接、实际async-await及Promise续体回归。

最终联合回归79项：76通过、0失败、3个真实ASR/OCR/OpenPorts opt-in未启用而明确跳过；其中新基础模块11/11。本阶段未改Flutter执行代码，未重跑Flutter构建/真机。上一阶段真实链路验证不等于本次重新运行。

## Boundary lab 0.2

微内核21/21通过（基础12、边界9）。新测试覆盖子Grant衰减与原子预算切片、祖先撤权、观察过期锁存、失败引用之后重开存储并回拨不复活、跨Artifact来源闭包、撤权后低权限尝试拒绝、纯新Context不携带隐式历史、读/发授权不能拼接、Context分配预算、多个来源的预算失败全回滚、数据控制者匹配及披露重放无正文。

非法ack的then getter、Proxy traps、带constructor getter的Promise均在属性调用前拒绝；利用Node特有原生检测，不宣称通用JavaScript可无副作用检测所有代理或隔离任意恶意宿主异步代码。

最终联合回归89项：86通过、0失败、3个真实ASR/OCR/OpenPorts opt-in跳过。未改Flutter代码，未重跑其构建或真机；没有现实业务写操作。此轮验证仍不覆盖完整微内核契约。
