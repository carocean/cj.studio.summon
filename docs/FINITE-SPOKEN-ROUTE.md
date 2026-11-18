# 有限语音路线闭环（本机合成服务）

这是生成式系统的受限纵切，不是通用 LLM 理解、真实地图或手机采集证明。生物、感知、授权、服务事实和呈现分开；听到一句话本身不赋予服务权限。当前默认模型仍为 Vosk，新增可选 Paraformer。

## 用户路径

1. 在生物市场主动订阅“演示地图”，独立允许合成路线能力。订阅不授予该生物听觉/视觉，不替换主生物。
2. 为当前生物显式开启听觉，输入 WAV。支持的简短整句示例：**“演示地图，从甲站到丙站。”**。地点只允许甲/乙/丙站（A/B/C），提供者只允许演示地图。
3. 真实 ASR 的原始结果由有限整句语法校验；不能识别就不提案，不偷偷纠词。视觉 OCR 文字不能生成路线提案。
4. 候选绑定感知事件、当前生物/场景版本、提供者/订阅实例、授权世代、期限及固定请求 ID。用户再次明确确认才调用模拟服务；缺订阅/授权只解释，不自动补齐。
5. 完成回执匹配后才切到地图生物并显示合成路线场景。界面可关闭，回执仍持久保存。显式点朗读后，才用本地 MeloTTS 读该回执；不接收客户端任意朗读文本。

另一允许的长句为“请用演示地图从甲站到丙站规划合成路线”（请可省略）；精确语法见 `runtime/src/spoken-route.js`。否定、引述、附加要求、真实地名和其他提供者均不作推测。允许短句是公开的语法，不是把识别错误映射为正确命令。

## 服务与恢复契约

- `POST /scene/sense-route-confirm`：eventId/context/expectedProposal/confirmation，确认值必须为 `request-synthetic-route`。
- `POST /scene/sense-route-status`、`/scene/sense-route-cancel`：eventId/expectedProposal。来源撤权后仍允许所有者查询事实或取消，不能借此重派。
- `POST /scene/route-speak`：receiptId/context。服务器只从对应合成回执生成固定播报词；后台/离页/主体变化停止客户端播放，服务端迟到结果再检查当前上下文。
- 请求未知或 pending 不自动重试；not_started 只是查询结果，不是重派许可。取消持久墓碑阻止迟到调用；已完成事实不伪装为撤销。历史确认返回 replayed，不新执行或自动切回场景。
- 确认前、执行后都检查感官/订阅世代及场景版本；ABA 撤权再授权不会让旧候选有效。查询观察到过期也持久标记，重启和时钟回拨不能复活。无法观察到的时钟变化不声称完全单调保证。
- 原始转写不保存到事件快照；感知原文件暂存清理。当前仍是 loopback 单演示 owner/可信宿主，无生产身份认证、任意模型隐藏状态或分布式执行保证。

## 可选真实中文识别器

宿主设置：

```sh
export SENSE_ASR_ENGINE=paraformer
export SENSE_PARAFORMER_MODEL=/absolute/path/to/paraformer-model-directory
export SENSE_PYTHON=/absolute/path/to/python-with-sherpa-onnx
```

模型目录需 `model.int8.onnx`、`tokens.txt`；Python 需 sherpa-onnx/numpy，宿主需 ffmpeg。默认 Vosk 不变；未知引擎、缺文件、Paraformer 非 zh 输入明确失败，不静默降级。两引擎均限 WAV/4MiB/15秒，统一解码16k PCM；全零输入明确拒绝，**不是通用静音/噪声检测保证**。

来源：[sherpa 官方模型说明](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/paraformer-models.html#csukuangfj-sherpa-onnx-paraformer-zh-2023-03-28-chinese-english)、[维护者转换模型](https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-2023-03-28)、[上游 Paraformer](https://www.modelscope.cn/models/damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch)。验证转换版本 `fe3e2bbfa0a0d3789b653c4b6cf3f87a5dbf2b94`；INT8 文件223385835字节，SHA256 `9ada9127ca5b82320385ac12340eb8b05dee64fd45cf8cf593ec693826ec2fd7`。转换模型卡标MIT，上游标Apache2.0；保留两者来源与许可义务，不能把转换许可视为抹去上游义务。权重不入库。

## 实测证据与限制

三段同一个 MeloTTS 声音生成的中文 WAV，未更改原转写：

| 输入 | Paraformer 16k 实际输出 | 有限解析 |
|---|---|---|
| 请用演示地图从甲站到丙站规划合成路线 | 使用演示地图从甲站到丙站规划和城路线 | 拒绝 |
| 演示地图，从甲站到丙站。 | 演示地图从甲站到丙站 | A→C 候选 |
| 请用演示地图，规划从甲到丙的路线。 | 形用演示地图规划从甲到丙的路线 | 拒绝 |

既有 Vosk small 对三段均未产生合格命令。Paraformer 小样本可跑，但不代表真人/口音/噪声准确率；无正确性统计结论。真实整链测试覆盖三段识别、仅第二段产生候选、无确认不执行、参数篡改拒绝、一次模拟回执、真实 MeloTTS WAV、历史重放、隐藏与重启恢复。它是**真实模型处理合成音频**，不是麦克风或扬声设备验证。

运行 `runtime/test/spoken-route-real.test.js` 需显式 `SPOKEN_ROUTE_REAL=1`、`SPOKEN_ROUTE_FIXTURES` 指向三段 route-command-{1,2,3}.wav，以上 ASR 配置以及 `VOICE_PYTHON`、`VOICE_MODEL_DIR`。没有模型/固定素材时默认跳过，不冒充验证。Python 回归见 `server/senses/test_paraformer.py`。

0.5B/1.5B/4B 本地规划模型均未达到当前拒绝/边界要求，未接主链，详见 [评测记录](LOCAL-MODEL-EVALUATION.md)。本轮不调用付费模型、不训练模型、不接真实 Google/银行、不发布外网。后续扩大表达范围必须重新测评来源、意图及参数约束，不能仅扩大正则而声称通用生成。

## 自愿轮流说话模式

听觉页的“轮流说话：录完即发送”默认关闭、只在本页有效。打开前说明每轮仍手动点开始/结束，手动结束即发本机识别，不再另点发送。到14秒时限只停止并保留预览，不自动发送；取消本轮不会上传。它不是 VAD、免提常听或自动下一轮，也不会自动朗读、确认候选或调用服务。

录音前必须确认播放器停止；停止失败不打开麦克风。录音中、待发媒体、候选或未知路线请求不能随意改变该模式。处理未知时关闭模式、不重发媒体；未决路线请求阻止下一轮覆盖恢复入口。后台/失焦清除原媒体、转写和回应并锁定采集；未决路线仅保留请求绑定元数据，以便显式查询或取消，不能重新确认或自动呈现场景。组件关闭/进程退出后没有客户端持久恢复箱；历史服务事实仍以服务器记录为准。

组件测试覆盖轮流发送、时限、取消、后台恢复和播放器停止失败，但手机权限弹窗/音频设备实际时序未实测。
