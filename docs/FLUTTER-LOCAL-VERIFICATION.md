# Flutter 本机验证与 CI 模式

## 阻碍与查证

一次独立组件测试因尝试访问云实例 metadata 被执行平台拒绝。没有放行该地址、探测凭据、修改网络限制、改SDK或换环境重跑。随后只读检查已安装官方 Flutter SDK，定位到 `packages/flutter_tools/lib/src/base/bot_detector.dart`：当未明确声明 CI 且无缓存检测结果时，BotDetector 可调用 AzureDetector 探测实例元数据；存在 CI 环境变量则在此之前直接返回，不进入检测。

本次查证的 Flutter checkout 为 `ab2912035e160d9cad6306df307576da6128ebdb`。应用及测试代码中未检出该metadata地址。此前实施侧使用CI模式而独立复核漏设该变量，解释了两者不同的启动行为；没有假定安全平台误报。

在核实源码并获得任务协调方同意后，同一沙箱使用官方CI模式执行本机测试，成功启动。该方式是删除不必要的元数据探测，不是让被拒请求改道执行。若任何工具再次拒绝，应停止、保留原因并重新调查，不反复换路径、代理或进程规避。

## 已安装依赖下的命令

在 `app/` 目录，用已安装 Flutter SDK及已解析的 pub cache：

```sh
CI=true flutter test --no-pub --reporter expanded
CI=true flutter analyze --no-pub
CI=true flutter build web --no-pub --release
```

本地Dart→Node HTTP验收另外显式启用：

```sh
CI=true SUMMON_SCENE_LIVE=1 flutter test --no-pub test/scene_live_test.dart --reporter expanded
```

HOME/PUB_CACHE需指向当前受控环境已有的工具目录，不能借此寻找其他用户凭据。`--no-pub`用于本轮已安装依赖，不能使缺依赖的机器自动准备好；不得为“离线成功”假报缺失依赖已经验证。CI变量不是网络沙箱，也不保证任意新增测试/插件不会联网，仍需检查其行为。

## 本轮首先发现的问题

恢复执行后的契约相关测试：20通过、1失败。失败是已完成账户任务仍显示禁用的提交按钮，违反原生命周期期望。这是真正执行发现的回归，不以静态审查或旧版本测试替代。修复应隐藏终态保存/提交动作，而不是改断言来掩盖它；最终回归结果另行记录。

后续已修产品，不改原终态断言；正式CI执行：静态分析通过、完整149项测试通过/1项默认跳过，实际Dart→Node新表单契约HTTP链1/1通过。Web构建结果在完成后记录，不将测试通过等同真机验证。

最终Web release构建通过（61.5秒）。分析、完整组件集、真实本机HTTP及Web均采用同一受控环境的CI=true/--no-pub流程，未再遭平台拒绝；没有执行元数据探测或更改网络策略。通过的是本机验证，不是iOS/Android打包、真机硬件或公开发布。
