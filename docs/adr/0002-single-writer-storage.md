# ADR 0002：单写域事务与崩溃恢复

状态：限定原型采用，待崩溃测试验证。不是旧JSON Kernel的升级声明。

## 决定

使用Node24.22.1已提供的node:sqlite DatabaseSync，独立新存储，不迁移旧JSON数据。单个本地数据SQLite文件，rollback journal DELETE模式、synchronous=EXTRA、foreign_keys=ON、trusted_schema=OFF；逐项读回检查，拒绝静默配置失败；禁扩展加载，参数化SQL。仅可信本地磁盘，不用于网络文件系统。

Node同步API与本机已核版本见[官方文档](https://nodejs.org/download/release/v24.22.1/docs/api/sqlite.html)。SQLite事务与PRAGMA行为依据[事务说明](https://www.sqlite.org/lang_transaction.html)和[PRAGMA](https://www.sqlite.org/pragma.html)。选DELETE而非WAL是为了首版单写/小记录减少checkpoint与共享内存恢复路径，不声称性能更优。

### 单进程持有权

以数据文件规范路径派生专用锁SQLite文件。锁文件先初始化，再由进程生命周期持有BEGIN EXCLUSIVE事务；第二进程即时拒绝，不用PID存在与否猜测、不自动删除“陈旧锁”。进程死亡由OS/SQLite释放文件锁。数据DB任何初始化/迁移/恢复写入必须在锁库独占权取得后执行，锁失败关闭全部句柄，不允许半初始化继续。真正业务记录只写数据DB，其事务独立提交；锁库不存业务事实，不要求跨库原子性。

路径在受控私有目录解析，拒绝不受支持的别名/符号链接用法。恶意同OS用户绕过目录权限修改数据库、硬链接别名或破坏锁不在首版保证内。锁DB/dataDB不得在运行中删除或替换。

### 原子边界

每个变更使用BEGIN IMMEDIATE →验证CAS/唯一约束→写入→COMMIT，异常ROLLBACK。事务函数必须同步，禁止把网络/模型await放入事务。不接受返回Promise的回调。数据与命令ack同事务，不能“先改状态后补幂等记录”。

以下各自是单事务：父预算切片+子Grant；活动active slot+attempt+预算保留+issued Permit；Permit消费+出站意图记录；Receipt追加去重+事实派生状态；取消意图+未消费Permit撤销/预算释放。数据库唯一约束防重复commandId、重复Receipt issuerMessageId和同活动多个active slot。

## 崩溃点与恢复

| 崩溃点 | 恢复结果 |
|---|---|
| 变更事务提交前 | 全部回滚；无已授权出站记录 |
| issued提交后、消费前 | 只有未消费许可，重查权限后可消费；取消/过期可终止 |
| 消费事务中 | 原子保留旧issued或完整consumed+outbox，不存在半笔消费 |
| consumed提交后、发字节前 | 恢复uncertain，保守不自动重发；系统不能从无远端证据推断“未发” |
| 模拟接收端已处理、Receipt提交前 | 相同effectId查询接收端，或保持uncertain；不换ID重做 |
| Receipt+状态提交后、应答丢失 | command重放取历史ack，不再消费或发送 |

模拟接收端用独立持久效果表验证效果键，不把主DB与接收DB伪装成同一原子事务。每个崩溃点使用独立子进程退出/被杀再重启测试；另测第二写入者拒绝、磁盘写失败与CAS冲突。进程崩溃测试不是电源故障测试。

SQLite的持久性依赖OS/文件系统正确实现锁与同步，[原子提交说明](https://www.sqlite.org/atomiccommit.html)明确这些前提。不能声称已证明云盘断电不丢数据。首版不提供多节点fencing或分布式额度。
