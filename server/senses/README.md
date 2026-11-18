# 本地真实感知处理器

`processor.py` 是独立、离线、无付费 API 的文字感知适配器：

- 视觉：Tesseract 从实际 PNG/JPEG 像素识别可见文字。**不是通用场景理解、物体检测或人脸识别。**
- 听觉：Vosk 本地模型对实际音频做语音转写。**不是环境音分类、声纹识别，也不等于已实测手机麦克风。**
- 模型和识别结果可能出错。识别文字是来自传感器的非可信数据，不是权限或执行指令。

## 安装与配置

使用独立 Python 环境，安装 `requirements.txt`；本机另需 FFmpeg 与 Tesseract。权重从官方来源单独下载、解压到源代码目录之外。脚本运行时**不自动下载模型**，不连接外部识别服务。

```sh
python -m venv /path/to/sense-venv
/path/to/sense-venv/bin/pip install -r server/senses/requirements.txt
export SENSE_PYTHON=/path/to/sense-venv/bin/python
export SENSE_VOSK_MODEL=/path/to/vosk-model-small-cn-0.22
export SENSE_TESSDATA_DIR=/path/to/tessdata  # 可选；中文需 chi_sim 与 eng 数据
"$SENSE_PYTHON" server/senses/processor.py --capabilities
```

`SENSE_VOSK_MODEL` 必须是明确的本地模型目录。官方 `vosk-model-small-cn-*` 推断为 `zh`，`vosk-model-small-en-us-*` 推断为 `en`；其他模型需部署者明确设置 `SENSE_VOSK_LANGUAGE=zh|en`。请求语言不匹配时拒绝，不静默把英语模型冒充中文。该变量是部署配置，不接受终端用户文件路径。

`--capabilities` 报告引擎/模型结构是否存在及支持语种，不替代每次真实推理的成功结果。视觉 `languages` 为 Tesseract 数据名，`supportedLanguages` 为接口语种 `en`/`zh`。当前中文 OCR 同时使用 `chi_sim+eng`。

## 调用约定

```sh
"$SENSE_PYTHON" server/senses/processor.py \
  --modality vision --input /private/temp/capture.png \
  --input-root /private/temp --mime image/png --language zh

"$SENSE_PYTHON" server/senses/processor.py \
  --modality hearing --input /private/temp/capture.wav \
  --input-root /private/temp --mime audio/wav --language zh
```

stdout 只输出一条 JSON。成功包括 `text,engine,model,realProcessing:true,limitations`；失败非零退出且输出 `{error,realProcessing:false}`。结果中的 `empty` 表示没有识别出文字，不能推断“没有说话”或“图中没有任何文字”。不输出原文件路径或原始媒体内容。

父进程应创建私有临时目录并传 `--input-root`，输入应为新建普通文件。省略该参数时仅以输入文件父目录为边界，适合受信任本地 CLI，不是隔离任意用户路径的机制。最终文件符号链接、非普通文件、越界路径拒绝；FFmpeg 只从 stdin 读取，强制探测出的容器类型，协议白名单仅 `pipe`，不读取播放列表引用的文件或 URL。

限额：4 MiB 输入、8 百万像素、音频 0.1–15 秒；FFmpeg 输出固定 16kHz 单声道 PCM，超过时长拒绝，不把截断内容当完整识别。图像重编码去掉元数据后送 OCR。支持 PNG/JPEG 与 WAV/WebM/Ogg/MP4/MP3 容器，但某些容器/编码变体可失败；WAV 是首选可验证通路。模型文字输出最多 16000 字符。

每个 native subprocess 有 15 秒超时，处理器有 25 秒总报警期限；父进程仍应施加 30 秒超时、输出上限和低并发限制。Python 报警不是完整 native 沙箱，真实部署应另加进程/内存隔离。FFmpeg 单次分配上限 64 MiB，不是全进程内存保证。小型 Vosk 模型仍可能占数百 MiB，每个 CLI 调用会重新加载。

处理器本身不保存采集媒体或转写历史。父服务负责临时文件清除、授权、主体绑定和结果保留策略；不得把这一局部实现误称为完整隐私保证。

## 验证

```sh
SENSE_TEST_AUDIO=/path/to/permitted-test.wav SENSE_TEST_LANGUAGE=zh \
  "$SENSE_PYTHON" server/senses/test_processor.py -v
```

测试在临时目录生成 OCR 图片与越界音频。未配置真实模型/音频素材时，相关测试跳过，不能声称真实听觉已验证。

2026-11-17 本地实际验证：Python 3.12、Vosk 0.3.45、Pillow 13.0.0、Tesseract 5.5.0、FFmpeg 7.1.5。

- 合成英文图片 `SUMMON VISION 42` 真实 OCR 原样识别。
- 合成中文图片真实 OCR 能识别主要文字，但把“视觉”误为“视帝”，明确存在字误差。
- 中文测试 WAV（5.592 秒）经 small-cn-0.22 真实转写为“开放 时间 早上 九点 至 下午 五点”。转为 WebM/Opus 后也真实转写相同。
- 官方 Vosk 英语 test.wav（8.308 秒）经英文模型真实转写有部分数字词误差；不宣称无误识别。
- 五项处理器测试通过：真实 OCR、类型/大小/像素/路径边界、不自动下载/语种回退、过长音频拒绝、真实中文语音转写。未进行真实摄像头或麦克风录制。

## 官方来源与许可边界

- [Vosk 官方模型列表](https://alphacephei.com/vosk/models)：small-cn-0.22 与 small-en-us-0.15 均列 Apache 2.0；模型不加入本仓库。
- [Vosk 官方 Python 示例](https://github.com/alphacep/vosk-api/tree/master/python/example)，英语测试音频来自该目录的 test.wav；只在本机验证，不复制入库。
- [Vosk PyPI](https://pypi.org/project/vosk/0.3.45/)：Apache 2.0。
- [Tesseract 官方仓库](https://github.com/tesseract-ocr/tesseract) 与 [官方快速语言数据](https://github.com/tesseract-ocr/tessdata_fast)：Apache 2.0。中文/英文数据仅安装在工作区外的模型目录，不加入仓库。
- 中文测试音频为 [sherpa-onnx 官方文档指向的 SenseVoice 示例](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)。音频文件独立许可未确认，**仅本地验证，不再分发、不加入仓库**。
- FFmpeg/Pillow/native 二进制未再分发；部署者应核对所安装构建及依赖各自许可。
