# 临时阅读视图：单可信宿主、纯内存

`ReadingViews` 复用 HostIdentity 和 reading纯层，不复用表单会话、不访问 SnapshotStore。
没有HTTP/LLM/URL获取、自动usage、书签、历史、读取时间或持久化。只有synthetic测试。
资源安装和授权是可信宿主决定，不证明许可、字体实际可用或用户读过。

## 宿主配置

`new ReadingViews(identities, options)`：administrator默认`host-admin`；installedFontIds
默认空数组并严格clone/冻结/验证。身份域必须是可信HostIdentity，不是用户提供的回调。
只支持同步单实例，不宣称线程安全/分布式原子性。构造生成随机只读`epoch`。

容量默认：16资源版本、256访问记录、每owner64个终身view ID、256条终身命令；
显式配置上限分别64/1024/256/1024，不按页或滚动次数套用form额度，没有TTL。
关闭view不回收ID、回执或容量。容量饱和拒绝新命令，已有精确命令仍可查/重放。
若命令额度用尽close也拒绝，不假称已关闭；宿主可用独立admin撤权阻止继续访问。

- `installResource(adminHandle, compiledResource)`：安装精确immutable resourceId+digest版本。
  相同key仅完整同值幂等；provenance不同也冲突，不能利用contentDigest不含provenance
  覆盖来源。新版本独立安装，不自动迁移访问权、view或anchor。
- `setAccess(adminHandle,{ownerId,resourceId,contentDigest,enabled,expectedGeneration})`：
  默认无授权，首次expectedGeneration=0。每次成功都generation+1，包括同值重授权。
  无删除/重置。旧view绑定原generation，撤权重授也不能复活。此配置无command回执，
  是同步host CAS入口，响应丢失时不可假装幂等重放。

授权和资源也只在内存。重启后全部为空、默认deny，必须由宿主明确重新安装/授权；
此行为不是自动恢复或静默重新授予。不同owner由HostIdentity.resolve结果隔离，普通
请求不接受owner、正文、URL或完整resource。admin目标owner是显式宿主配置。

## owner API

所有请求带当前epoch；所有API先认证再判断epoch，错误epoch为`reading_instance_lost`。

```
open(handle, commandId, {epoch,viewId,resourceId,contentDigest,presentation})
read(handle, {epoch,viewId})
updatePresentation(handle, commandId, {epoch,viewId,expectedRevision,changes})
updateAnchor(handle, commandId, {epoch,viewId,expectedRevision,anchor})
close(handle, commandId, {epoch,viewId,expectedRevision})
query(handle, {epoch,commandId})
```

open创建纯层revision1。update通过原纯层CAS，各自只更新presentation或anchor，另一方
保持原值。read另核当前访问代次/状态，不改变revision、不创建事件。read返回冻结resource
及state。访问检查和身份检查在返回/修改前复核，过程中不运行用户回调。

close可在资源已撤权后显式关闭本人的view，不返回正文。close回执revision表示最后一个
reading-state revision，status另变closed；不伪造新阅读状态。关闭后迟到的新update拒绝。
不自动切换UI；已经交给客户端的正文无法通过撤权收回。

命令先纯准备，再一次同步提交内存view和最小回执。失败不写回执或改变view。回执只含
fact/epoch/viewId/revision/resourceId/contentDigest/accessGeneration，不含正文、anchor或
完整state。原ID同payload返回原回执，不重新执行；不同payload冲突。已关闭、已撤权的
原命令也只能重放历史元数据，不能恢复view或借回执重新披露正文。
query返回`completed`及原ack，或本实例该owner未提交该ID的`not_started`。
后者不证明从未有过失败尝试，也不保证随后不会收到迟到请求。
旧epoch不能用新实例的not_started掩盖丢失；新epoch查询只回答新实例范围。
身份撤销使旧handle无效；宿主重新authenticate同owner本身不撤销资源授权，资源访问
撤权必须显式setAccess。权限generation不同于身份epoch。

## 非目标

无微内核GrantLedger委托/计费，也不冒充其derive/disclose授权。这里是明确的宿主访问
表；未来需接GrantLedger时另定义scope与撤销契约。无持久CAS或跨崩溃去重承诺。
未来“保存阅读位置”须独立明确确认、SnapshotStore原子书签与回执，不能自动保存此view。

## 显式宿主退役

**构造新对象不会退役旧对象。** 真正的进程终止才使该进程的内存实例消失；同一进程
同时保留两个实例时，旧对象仍可处理其旧epoch请求。上面的新实例/重启测试只证明
新实例状态为空，不能证明旧对象自动关闭。

`retireHost(adminHandle)` 是可信宿主显式生命周期操作：合法管理员认证后永久标记
本实例retired，清空其资源、访问表、views和命令回执。重复合法管理员调用返回
`alreadyRetired:true`；epoch仍保留原值作为元数据，不产生新代，也不允许原对象重用。
不依赖owner命令额度，因此额度饱和仍可退役。普通owner不能调用；非法handle仍报
unauthenticated，不能从退役状态绕过认证。其余API在identity/管理员权限检查后统一
拒绝`reading_host_retired`，包括历史回执查询、精确重放、安装、授权、read/update/close。

清空的是明确临时内存，不是持久数据删除、书签删除或对已披露文字的收回。旧调用者
持有的冻结返回对象不会消失，也不保证运行时内存被安全擦除。新实例仍独立默认deny。
未来transport切换必须由宿主明确退役旧实例并隔离旧路由，不能仅new对象就称旧服务停止。

## SceneLab 最小传输（五路，默认空）

SceneLab只提供单demo-owner组合，不是生产多租户认证。可信`readingOptions`仅字体能力
和容量配置；默认字体能力空，默认无资源及访问。显式给`SummonPreviewSC`也只声明宿主
能力，不证明客户端字体已经加载或具备许可。

仅host调用`installReadingResource(compiledResource)`及
`configureReadingAccess({resourceId,contentDigest,enabled,expectedGeneration})`，owner/admin
由SceneLab内部决定，不能注入。可在host先使用UTF8 excerpt适配器，但没有网络获取或
许可保证；HTTP不可上传正文、资源evidence、owner、URL或授权开关。

- GET `/scene/reading-state` → `{epoch,persistence:'volatile'}`，不列书目或正文。
- POST `/scene/reading-open` → `{commandId,epoch,viewId,resourceId,contentDigest,presentation}`。
- POST `/scene/reading-read` → `{epoch,viewId}`。
- POST `/scene/reading-query` → `{epoch,commandId}`。
- POST `/scene/reading-close` → `{commandId,epoch,viewId,expectedRevision}`。

结果沿用上文host API（open/close为`{replayed,ack}`）。所有POST严格UTF8、4096字节
原始JSON上限。保护门只增加这五条精确路径，继续直接TLS/cookie/Origin/CSRF/no-store；
无style/anchor更新路由，无自动书架或固定古籍。read仍按既有48KiB resource边界返回。
断连只代表结果未知，不自动close/retry；原epoch、原IDquery恢复事实后再独立read。
新epoch的not_started不能回答旧实例的结果。资源不匹配或访问撤销不得静默迁版本。

SceneLab.close先退役ReadingViews再关闭其余服务；state也检查lab仍open，不在关闭后
仅返回epoch而暗示服务可用。重建SceneLab得到全空新实例，不从SQLite恢复临时阅读。
测试通过真实HTTP与受信任临时CA的TLS，覆盖两份synthetic资源、丢响应后query、撤权
重授、默认deny、字段/字节/UTF8拒绝、容量、关闭重启，且SQLite resources/commands/events
及usage在这些阅读操作前后逐项保持不变。未启动Flutter/模型，也不称真实阅读UI验收。
