# 同次真实语音模型→Flutter详情联调

## 本轮新增证据

在同一个可重复实验中串接：真实离线TTS生成输入录音→真实Vosk转写→真实本地Qwen2.5-1.5B→宿主待确认→真实TLS会话/CSRF→Flutter测试明确点击→同菜SQLite详情→Flutter正文可见。

不是将此前两个独立实验拼在一起。原生产代码、提示词、确认协议与预期标签均未修改；新增的只是opt-in联调宿主、测试、清理回归与证据。未修改公开仓库。

## 结果不能概括为“全部通过”

固定三条表达，最终运行如下（冷启动本地模型、生成临时证书等均计入墙钟时间）：

| 输入 | 实际ASR | 模型类别 | UI与严格结果 | 到正文/反馈 | 整项耗时 |
| --- | --- | --- | --- | --- | --- |
| 这是什么菜？ | 这 是 什么 菜 | explain | 明确点击后同菜正文可见，通过 | 15.309秒 | 15.874秒 |
| 解释一下这道菜。 | 你 试 一下 这 道 菜 | explain | 明确点击后正文可见，但ASR错了 | 14.788秒 | 15.000秒 |
| 不要介绍这道菜。 | 不要 介绍 这 道 菜 | clarify | UI安全拒绝，无确认请求/按钮/正文，SQLite仍none；预期none，严格失败 | 13.082秒 | 13.391秒 |

最终2通过、1失败，测试仍以非零状态退出。否定的安全不执行不是正确理解否定。第二条的最终动作匹配原输入也不是ASR正确，更不能把模型对错误转写给出explain包装成可靠纠错。

先前同配置1.5B运行也得到两个正文正例与否定clarify；逐例实验日志未纳入公开发布。两次运行不足以评估稳定性或通用准确率。没有调整错误文本、加关键词修补或修改预期。

## 为什么使用1.5B而不是4B

最初尝试此前的Qwen3-4B与Flutter同运行，模型监督进程报告SIGKILL，三个用例均planner_transport_error。随后尝试Flutter启动后再加载4B，fixture仍在ready之前退出，当时尚未捕获确切退出原因。资源压力是推测，没有拿到OOM原因证据，不能断言。

这些属于基础设施失败，不计作语义正确率样本。本机另有已安装的Qwen2.5-1.5B-Instruct-Q4_K_M及Apache-2.0许可，明确切换该测试模型后获得上述新链路证据。**1.5B结果不替代4B验收，也没有修改生产默认模型。**

1.5B权重SHA256：`6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e`。llama.cpp b12483，CPU双线程、上下文2048、单槽、无GPU、reasoning off；temperature0、seed42、max_tokens180。模型名字段只是宿主标签，证据同时记录文件hash与实际显式启动配置。

## 真实与受控边界

真实：输入音频TTS、Vosk推理、本地LLM、TLS证书验证/会话/CSRF、SQLite运行时、Flutter组件与正文。

受控：输入语句是固定合成录音，不是真麦克风；narrator合成与物理播放器/停声是fixture；确认是Flutter测试tap，不是真人；目录菜品是合成数据；不是手机真机、完整浏览器安全或全双工验收。

正文展示必须经过现有明确确认与绑定检查。模型不可信输出、网页/agent内容没有获得用户通道权限。否定失败也不会自动点确认。没有新增生产网络端点。

## 启动与清理

测试宿主可使用已有模型服务，或在Flutter初始化后以`DISH_REAL_UI_OWN_MODEL=1`启动显式指定的本地二进制/权重。spawn使用参数数组、无shell、固定127.0.0.1:18083。所有模型只在本机，无下载或远程fallback。

在异步初始化前安装SIGTERM清理；输入TTS使用AbortSignal，关闭时等待TTS/pipeline结束，随后关闭TLS/数据库。自有模型在finally中TERM，必要时5秒后KILL并等待close；不终止外部监督服务。

真实启动期取消回归通过1/1：在专用TTS scratch出现后取消，Node退出且专用scratch清空。此前基于/proc枚举子PID的测试未能观察到子进程而失败，已改为本用例的可观测清理证据；不声称直接用/proc证明了子PID回收。

## 复现

显式export本机已安装路径（不提交凭据），从app目录运行：

```sh
export DISH_REAL_UI=1 DISH_REAL_UI_OWN_MODEL=1
export DISH_REAL_UI_MODEL_BIN=<已安装llama-server绝对路径>
export DISH_REAL_UI_MODEL_FILE=<已核验1.5B权重绝对路径>
export DISH_LLM_ENDPOINT=http://127.0.0.1:18083/v1/chat/completions
export DISH_LLM_MODEL=summon-local-qwen25-15b-q4km
export VOICE_PYTHON=<离线Python绝对路径>
export VOICE_MODEL_DIR=<vits-melo-tts-zh_en绝对路径>
export SENSE_PYTHON=<离线Python绝对路径>
export SENSE_ASR_ENGINE=vosk SENSE_VOSK_LANGUAGE=zh
export SENSE_VOSK_MODEL=<vosk-model-small-cn-0.22绝对路径>
flutter test --no-pub --concurrency=1 test/dish_real_pipeline_live_test.dart
```

默认不开启上述标志，三个真实模型测试跳过。明确开启后，当前否定例应失败，不能将默认回归全绿当作真实语义验收通过。端到端延迟是本次CPU、冷启动和测试调度下的测量，不是产品延迟承诺。

## 最终回归与审查

- Node默认486项：472通过、14跳过、0失败。
- Flutter默认398通过、5跳过、0失败；其中新增三项真实模型测试默认跳过。
- 最终真实模型明确开启：2通过、1严格语义失败；真实取消清理1/1通过。
- Flutter静态分析无问题。独立只读终审核对绑定/清理/失败不授权、日志真实性、延迟数字及源码hash，未发现新P2。

本轮仅新增测试、实验宿主、证据和文档，未改变生产代码或安全确认行为。
