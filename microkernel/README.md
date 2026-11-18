# Microkernel lab · linked permit lab 0.4

独立的**受限微内核实验目录**，不替换现有 `server/`，不对外提供API。

基础原语：

- C1规范编码、种类隔离SHA-256摘要、无调用者引用的不可变快照。
- 本地可信宿主的不可序列化身份句柄及撤销；不是生产身份认证。
- SQLite单写进程锁、版本化资源/CAS、同步事务和同事务command历史ack。
- 真实子进程在提交前/后SIGKILL后的恢复验证。

```sh
# Node 24.22.1（本轮实际环境；本目录版本要求独立于旧server）
cd microkernel
npm test
```

最新增加Grant衰减、预算片、环境构造的不可变Context闭包与本地披露门，范围和限制见 [BOUNDARY-LAB](BOUNDARY-LAB.md)。原边界切片21项测试通过；新增Permit切片见下文。

新增固定模拟Permit/单slot/独立sink和崩溃核对，40/40测试通过，详见 [PERMIT-LAB](PERMIT-LAB.md)。已联通受控Artifact来源及数据Grant的消费校验，但尚无通用可委托执行Grant、重派fencing、生产broker、真实模型上下文隔离和完整业务事实状态机；不能称为完整微内核。此目录为可信宿主内部实验，不提供外部API，不是生产认证或插件沙箱。没有真实网络业务写操作。

四份决策见 `docs/adr/0001`–`0004`。测试含进程崩溃，不等同电源断电或损坏磁盘测试。旧应用的模型/界面不会自动获得新契约保证。

设计参照：[Permit 实验计划](../docs/PERMIT-LAB-PLAN.md)。产品主线：[生成式系统验收](../docs/GENERATIVE-SYSTEM-ACCEPTANCE.md)，包含默认多生物听视觉、业务结构化表单按需生成/更新/收起，不把通用文本框当目标。
