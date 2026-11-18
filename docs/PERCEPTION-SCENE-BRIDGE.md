# 感知事件到生物场景：受控本机桥

## 已连接的实际模块

新runtime通过进程内`PerceptionSceneBridge`调用既有`PerceptionService`和`LocalSenseProcessor`，不是接受前端自报的可信识别结果。Vosk对真实WAV执行本地语音转写，Tesseract对真实PNG/JPEG执行OCR；没有付费服务或通用LLM。

runtime首次初始化分别建立“小伴感知主体”和“小谨感知主体”，持久记录可信映射。请求只带当前产品生物ID与sceneRevision，不能指定另一个legacy感知主体。原感知服务继续校验owner、主体、感官能力及authorizationVersion。重启不会把已撤销的感官能力自动挂回。

这是本机单owner演示政策，不是生产身份认证。首次初始化授予的是本地处理能力，不是浏览器/手机麦克风或相机权限；设备采集仍需显式操作、系统授权和确认发送。

## 两个独立门

1. **观察门**：请求在开始前绑定当前生物和持久sceneRevision；处理完成后重新核验同一绑定和原感知授权世代。切走再切回、编辑任务或撤权重授都会使旧结果失效。事件有30秒期限；观察到过期会持久锁存，回拨不复活。
2. **场景提案确认门**：OCR只有观察，图片上的文字不可能获得指令权限。听觉也不是身份认证；仅少数精确词句可产生有限提案，例如“开始工作”“模拟开户”“回到小伴”。提案不会自动切换主体、提交表单或执行服务。用户必须另行确认明确提案，应用时再次核验感知授权、期限和绑定，并原子标记已应用。重复确认只返回历史结果，不重复切换。

未知语句保持观察，不猜测意图。当前fixture里的“开放时间早上九点至下午五点”因此不会切换场景。业务只允许合成预览，确认“模拟开户”最多创建草稿表单，不会开户或发送真实资料。

## 数据与生命周期

原始媒体交给既有处理器临时目录，成功/失败后清理。返回的识别文字仅用于本次界面显示；两个持久存储均只保留感知ID、主体/场景绑定、引擎、模型名、字数与候选枚举，不存原始文本或媒体。ASR使用离线声学模型；“llmUsed:false”不代表没有模型，而是未调用通用LLM。

关闭采集界面应停止本地录制并丢弃未发送材料。已经确认发出的本地处理可能完成到30秒超时上限，关闭界面不承诺撤回已经发送的字节；迟到结果不会自动改变场景。请求格式/大小/媒体编码先校验，不占事件槽。当前桥保留最多64个可用事件；终态或已到期事件可退役，未确认且仍有效的事件不被覆盖。退役先在core持久锁存，再清理专用legacy owner的终态元数据；中断后依据保留ID集合重做清理。旧确认不可复活。构造必须显式声明exclusiveOwner，不能挂到普通用户共享的感知历史上。core版本化退役记录仍占磁盘，不声称总存储有界，也没有多租户配额保证。

两个持久存储仍由同一可信进程同步执行最终检查和场景提交，没有await间隙；这不是跨主机事务或不可信执行器隔离。来源文字不充当授权。个人场景视觉收起也不等于多个Agent的数据隔离，当前API仍是同owner视图。

## 本机运行与复验

```sh
# 设置已安装的本地引擎/模型路径，不把权重或媒体提交仓库
export SENSE_PYTHON=/path/to/venv/bin/python
export SENSE_VOSK_MODEL=/path/to/vosk-model-small-cn-0.22
export SENSE_TESSDATA_DIR=/path/to/tessdata
cd runtime
npm start
```

实际链路测试：

```sh
SENSE_BRIDGE_REAL=1 \
SENSE_TEST_AUDIO=/path/to/test-zh.wav \
SENSE_TEST_IMAGE=/path/to/ocr-en.png \
node --test runtime/test/perception-real.test.js
```

在仓库根执行，且沿用上述SENSE环境。测试经真实HTTP提交文件字节，验证Vosk/Tesseract的真实结果、当前主体事件、无自动场景动作、原文不入库与临时文件清理。普通边界测试明确使用mock处理器，不把其realProcessing测试字段当真实推理证据。

本轮未验证手机麦克风/相机硬件，不是实时多模态理解、环境音分类、说话者识别或一般视觉场景推理。LLM驱动的通用场景生成仍未完成。

## 本轮验证结果

- Node全套124项：120通过、4项需opt-in默认跳过。另独立启用本桥真实HTTP测试1/1通过，实际执行中文WAV→Vosk及PNG→Tesseract，验证主体事件及媒体清理。
- 桥接边界9项通过（容量修复前8项已独立复核）：主体绑定、切走再切回、授权撤销/重授、OCR禁命令、精确另确认、期限回拨、无效媒体不耗槽、超过旧100条上限后仍可用且旧确认不可复活。
- Flutter完整82通过、1项默认跳过；独立实际scene HTTP1/1、静态分析及最终Web release通过。绑定感知组件12项使用fake采集器验证UI控制流；相机适配器/页面10项验证延迟枚举、关闭、后台、迟到媒体清理及父路由不被二次弹出，均不是硬件测试。
- 新壳不再进入可另选主体的旧采集页；旧页仅开发入口。工作卡呈现声明改为必填、白名单、任务ID和修订一致，缺失时不渲染工作表单。

已完成的是当前生物绑定的真实离线处理及受控有限场景提案，不是持续监听、通用自然语言理解、真实银行办理或生产多用户身份隔离。

### 相机初始化的关闭边界

摄像头枚举返回后先检查页面是否已关闭；创建即持有pending session，关闭/hidden/paused时立即请求释放，并忽略迟到初始化或拍摄结果。支持文件IO的平台上临时图片走finally删除；Web端不进行文件系统删除，不声称已验证浏览器Blob的即时回收。退出中的页面不能再次pop误关父页面。相机插件自身可能等待已经开始的原生初始化完成后才释放设备，不能声称前端能够硬中断原生权限流程；这些是可注入适配器测试，不替代真机权限弹窗和硬件时序验收。

## Current-creature response (local-only increment)

After ASR/OCR completes, `creature-response.js` prepares a short response in the
current creature's tone. This is **deterministic local phrasing, not a language
model, open-ended understanding, general UI generation, or speech synthesis**.
The hearing command list and synthetic account schema remain finite. OCR remains
an observation; even text identical to a hearing command cannot propose a scene.
Unknown speech is acknowledged without inventing comprehension or actions.

`companionReply` is a closed `creature-reply.v1` envelope, bound to creature,
scene revision and perception event. Flutter requires those bindings and the
same candidate as the independently produced event. A reply never grants a
permission, submits a form, or supplies executable components. Separate explicit
confirmation still applies the scene proposal through the persistent scene
runtime; submission retains the existing Grant/Context/Permit/simulated-sink path.
No interface closes or replies cancel the persistent task.

The responder is a trusted-host injectable interface for testing and future
replacement, **not an arbitrary plugin sandbox or a configured LLM adapter**.
Its current input has identity/revision/event, modality and the independently
selected candidate and a recognition-present boolean only: no raw media, transcript, hidden history or memory.
It returns text only; extra keys or invalid text fail closed. The host stamps the
source as `deterministic-local`, so introducing a real model requires an explicit
new mode, truthful provider metadata, data-disclosure policy and further tests,
not merely swapping an endpoint under this label. Provider text is plain text,
not HTML. No external network/paid model call was added.

Since response preparation is asynchronous, authority and scene are rechecked
again after it completes, before output is committed or returned. Deadline checks
remain in the event commit. Errors return no partial response. This does not
prove arbitrary third-party model context isolation, prompt-injection immunity,
production identity, real camera/microphone operation, or general dialogue.

Regression coverage includes personality/event binding, OCR non-action,
revocation/regrant and context/expiry changes during response preparation, and
rejection of provider-injected action keys. Actual local ASR/OCR HTTP fixtures
also traverse the response step; exact command proposal fixtures remain separate
mock-processor tests where noted.

Response wait is now bounded (default 5 seconds, host configuration 1–30000 ms).
Timeout/bridge shutdown sends AbortSignal, rejects the response, and releases busy;
late completion cannot commit or return a reply. Each attempt has its own signal.
This only bounds the host wait: a provider that ignores cancellation may still
consume resources. A future subprocess adapter must kill/reap its child on abort;
a remote adapter cannot promise the remote compute stopped. No such adapter is
enabled by this change. Empty recognition explicitly says no text was recognized.

## Explicit offline speech output

When the host sets `VOICE_MODEL_DIR` to the installed MeloTTS directory and
`VOICE_PYTHON` to an interpreter with `sherpa-onnx==2.0.1`, `localSenses` enables
local voice. Without configuration, `voiceAvailable` is false. Configuration is
not a health guarantee; model/worker failures remain visible errors.

After a verified perception result, the host temporarily retains **only its
own generated reply** in a maximum-16-entry in-memory cache. No transcript or
client-provided TTS text enters it. The cache is not durable; a restart requires
a new perception. Expired entries cannot be spoken and are pruned on new results.
`POST /scene/speak` takes exactly `{eventId, context}` under the same loopback
lab boundary. It rechecks current scene, event deadline/status and sensory grant
before and after inference. Applied, expired, revoked, foreign or uncached events
are rejected. Explicit playback is separate from scene confirmation or execution.

The internal `LocalVoice` adapter starts a fresh Python child with minimal
environment, no network/download/history, one process-wide concurrent job and a
30-second default timeout. Cancellation/timeout kills the process group and
waits for process/stdio closure before releasing capacity. Temporary WAV is
private and removed on success, failure or cancellation. Output is bounded to
2 MiB and strictly checked for RIFF/PCM mono16 structure before any HTTP response.
The parent validates again; arbitrary client text, paths or URLs are not accepted.
There is no automatic fallback to browser/cloud speech or paid synthesis.

Flutter's explicit “朗读回应” control requests this exact event, validates its
binding and plays only after the user presses it. Backgrounding, closing or
starting another capture stops playback and rejects late results. Native playback
uses an owned temporary WAV cleaned on stop/dispose; Web uses player memory/blob
handling. Device/plugin and browser audio behavior still require hardware/browser
verification; unit/widget tests and valid server WAV do **not** prove users have
heard the audio. No automatic public loudspeaker output is introduced.

Real opt-in HTTP test combines `SENSE_BRIDGE_REAL=1` and `VOICE_REAL_TEST=1` with
the configured local ASR/OCR and voice model paths: WAV/PNG input → actual
Vosk/Tesseract → current-creature deterministic response → explicit speak request
→ real offline MeloTTS WAV. It does not replace device or human listening QA.

Host setup example (paths are deployment-specific):

```sh
# In the chosen local inference virtual environment:
python -m pip install sherpa-onnx==2.0.1
export VOICE_PYTHON=/absolute/path/to/venv/bin/python
export VOICE_MODEL_DIR=/absolute/path/to/vits-melo-tts-zh_en
node runtime/src/scene-server.js
```

Obtain the model only from the official sherpa-onnx TTS model release, retain its
MIT license and verify the package locally. Required model files are model.onnx,
tokens.txt, lexicon.txt and date/phone/number.fst. Model weights are not packaged
with the app or repository. Host configuration is trusted and must not be derived
from model output or request parameters. Flutter adds `audioplayers` (MIT); its
plugins must still be verified on deployment platforms.

Crash limit: ordinary completion/error/cancellation cleanup is tested. Abrupt host
or machine termination may leave a private temporary WAV; startup does not delete
unidentified other processes' scratch directories. Deployment needs an owned
scratch root and age/ownership-aware recovery before claiming crash-proof media
erasure. No audio playback acknowledgment is treated as proof a human heard it.

Playback cache detail: natural playback completion does not itself erase the
native temporary WAV. Stop, the next capture or leaving/disposal clears it;
load failure also performs cleanup. Linux tests verify the owned temporary
directory is mode 0700, not an untested universal platform permission guarantee.
