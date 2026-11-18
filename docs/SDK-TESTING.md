# SDK测试与遥测边界

2026-11-18跨稿独立测试曾被安全检查拦截：Flutter触发未授权Google Analytics请求。该次日志仅到loading，不计通过；工具未确认请求是否成功送达。应用业务链没有外部提交，不等于SDK工具自身从不访问外部网络。

只读核对当前官方Flutter源码、tool stamp和snapshot一致为`ab291203`，实际unified_analytics为8.0.18：
- `getAnalytics`看到`FLUTTER_SUPPRESS_ANALYTICS=true`，在构造真实Analytics之前返回NoOpAnalytics，`send`为空、telemetryEnabled/okToSend均false。
- 子进程统一抑制变量为`DASH__SUPPRESS_ANALYTICS=true`，Flutter进程管理器也传播它。
- `CI=true`单独不足：当前SDK对AI agent有例外。
- 不以`--disable-analytics`修复本次风险：当前runner可能先发出关闭统计事件再持久关闭。

当前测试使用进程级抑制，不改用户持久设置、网络规则或运行环境。已缓存依赖时采用：

```sh
FLUTTER_SUPPRESS_ANALYTICS=true DASH__SUPPRESS_ANALYTICS=true CI=true \
  flutter --no-version-check test --no-pub
```

SDK变更后需重新核对支持机制；不可将这些变量当成任意工具外发的授权或对所有网络的独立抓包证明。若安全检查仍拒绝，停止并报告，不换入口或间接执行绕过。原拦截与各次实际版本/验证范围必须保留，后续成功不追认被拦截运行。

## 集成测试调度

同源预览验收期间，多个Flutter全测/编译/独立验证同时运行出现长停顿：
最终一轮319项中315通过、4失败，默认Web编译主动停止（exit130），均保留原结果。
部分既有fixture使用5分钟真实墙钟期限，另有两个live测试共用8091端口；
这解释了可能的调度敏感性，但不能替代逐项复验或武断归因所有失败。

后续同一工作环境的编译与全测应串行调度，包含live测试的整套优先
`flutter --no-version-check test --no-pub --concurrency=1`，仍使用上述双NoOp环境。
不通过放宽业务TTL、断言或测试timeout把失败改成通过；先检查仅测试自建的
fixture是否正常退出，保留首次失败及后续同源码复验。禁止宽泛pkill或干扰用户试用服务。
