# Summon runtime · 合成场景纵切 0.1

运行单机 Node.js 的生物/情境/结构化场景编排，调用独立微内核。不需要 ECM、LLM 密钥或银行账户。

```sh
# Node 24.22.1
cd runtime
npm test
npm start
# 仅监听 http://127.0.0.1:8091
```

Flutter默认生物场景连接此服务，工程台保留在开发菜单；本机 Web 可用。手机上的127.0.0.1不是开发电脑，当前不宣称手机已连通。数据默认在runtime/.scene-lab，Git忽略SQLite文件；可用`SUMMON_SCENE_DATA`指定独立测试目录。

## 可操作闭环

1. 默认“小伴”日常伙伴，无聊天输入框；Flutter用完整可动形体呈现，呼吸/眨眼仅本地动画，不表示感知成功。显式模拟视觉工作情境可切换“小谨”业务伙伴。
2. 模拟听觉或视觉“开户需求”生成三字段合成表单。字段只有demo-a/demo-b、daily/savings、none/demo-email，拒绝任意姓名/证件/账号/自由文本。
3. 保存表单会增加revision。过期页面更新返回409，需要重新取状态，不偷偷覆盖或重提。
4. 明确提交才从已存表单生成不可变Source→Grant→Context→Artifact→Permit；数据权限与独立模拟执行额度都检查，sink再校验完整表单输入及效果摘要。
5. 返回“模拟服务已确认”，不是实际开户。重复提交复用固定命令身份，预算和效果不重复。
6. 收起表单、切回个人伙伴或重启服务，任务与字段仍在。关闭界面不取消任务，也不自动授予后台真实动作。未消费任务可明确取消；过期中断任务记录expired；完成/取消/过期后可明确开始新任务，旧记录归档。
7. 已消费不明任务只能核对，不能自动重发或新建同一业务；事实迟到与取消意图分离。当前模拟服务同步完成，不承诺完整后台任务调度器。

## API与边界

`GET /scene/state`；`POST /scene/perceive|update|submit|hide|show|cancel|new`。
POST必须JSON并带`X-Summon-Lab: synthetic`。仅loopback Host、http loopback Origin；不使用cookie，不允许任意跨域。这是本机单个合成演示owner，**不是生产认证或多租户API**。

`perceive`: `{modality: hearing|vision, signal: work-context|personal-context|account-request}`。
`update`: `{activityId, expectedRevision, values: {customerAlias, accountType, contactPreference}}`。
`submit`: `{activityId, expectedRevision}`。hide/show/cancel使用`{activityId}`；new使用`{previousActivityId: 当前任务ID或null}`。所有任务操作绑定任务ID，不能用同revision操作后来创建的另一个任务。所有成功返回完整state。

工程台的模拟感知按钮只产生合成证据，不调用摄像头/麦克风。生物页另有真实本地 ASR/OCR 感知桥（见下节），不要混淆两种入口。个性目前是持久设定与有限回应，不是个性化模型；业务表单和路线场景均为确定性受限呈现，不冒称通用生成式 UI。

## 验证

- runtime测试含真实loopback HTTP端到端、服务重启、隐藏任务存续、字段/修订/身份情境、重复提交、预算核对、中断过期、新任务归档。
- 内核仍独立跑编码、来源授权、预算、Permit及SIGKILL恢复测试。
- Flutter Widget测试核渲染/操作/错误；可选真实Dart HTTP联调自动启动临时Node服务：`SUMMON_SCENE_LIVE=1 flutter test test/scene_live_test.dart`（在app目录）。
- 没有真实银行、真实金融动作、真机传感器或真实LLM调用。Web release编译不等于手机硬件验证。

呈现策略位于`src/presentation.js`，从持久主体/任务状态产生有限`creature-scene.v1`声明（形体、语气、surface、任务ID与修订）。个人场景的呈现声明只建议工作任务摘要，表单只在工作场景渲染；单owner API仍返回owner完整任务数据，视觉收起不等于跨Agent隐私隔离。这种确定性投影不是通用LLM生成。

## 当前生物的真实本地感知桥

默认启动会初始化独立的本地感知主体映射。新壳听/看入口直接绑定当前生物与sceneRevision，通过`GET /scene/sense-capabilities`、`POST /scene/sense`和另行确认的`POST /scene/sense-confirm`接入。媒体只有用户明确确认后上传本机处理，OCR不能发指令；听觉有限提案也不自动应用。真实Vosk/Tesseract配置、授权撤销、保留与测试范围见[感知桥说明](../docs/PERCEPTION-SCENE-BRIDGE.md)。未配置本地引擎时显示不可用，不假报感知成功；业务效果仍仅合成。

## 有限语音地图与显式朗读

当前可选 Paraformer 将固定语法的中文识别结果转为路线候选；独立确认后才调本机合成地图服务，拿到回执才展示路线。请先主动订阅演示地图并独立授予路线权限，再对已开启听觉的当前生物说“演示地图，从甲站到丙站。”。不支持真实地名、其他地图厂商或自由改写。精确语法、模型安装环境、许可与三段实际音频结果见 [有限语音闭环](../docs/FINITE-SPOKEN-ROUTE.md)。

MeloTTS 已配置时，可显式朗读生物回应或当前路线回执；不自动播放。录音和播放硬件尚无真机验证，识别演示使用固定合成音频。声音听起来像一句命令不等于身份认证；独立确认与服务授权不可省略。
