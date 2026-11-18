# 本地中文字体准备产物（尚未接入 UI）

`NotoSansCJKsc-Regular.extracted.otf` 是从本机 Debian 安装的
`/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc` 提取的完整 SC Regular face。
它是重新封装的派生产物，不是下载的官方独立 OTF，不是按测试句子裁剪的 subset。
源文件未修改。生成过程无下载、模型、SDK 或浏览器调用。

原字体内部版权：© 2014-2021 Adobe (http://www.adobe.com/)。内部 name 13/14
声明 SIL Open Font License 1.1。随附 `LICENSE.noto-cjk.txt` 原样保留本机 Debian
字体包版权、来源及完整 OFL；它不是声称本产物由 Debian 或 Adobe 发布。
所查包版权声明和本 face 名称/许可元数据未指定 Reserved Font Name。
OFL 中的通用 Reserved Font Name 条款不是实际保留名称声明。保留所有内部名称、
版权和许可证字段；如替换字体来源须重新审查。字体保持 OFL，不单独销售，不暗示背书。

`audit.json` 记录源及产物 SHA256。实际 16,437,340 字节，低于既有 16 MiB
单资产上限 339,876 字节；未改 gate 上限。44,810 个最佳 Unicode cmap 映射、
65,535 个 glyph；全部原始表字节相同，唯一允许变化为 head.checkSumAdjustment。
整体 SFNT 校验和为 0xB1B0AFBA。完整 cmap 表也逐字节一致，不仅检查此次中文原句。

复现与检查：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 research/font-preparation/prepare.py --output /tmp/NEW-font.otf
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s research/font-preparation -p test_prepare.py -v
```

输出文件必须不存在；脚本拒绝超过上限，禁止自动提高上限。当前未改 pubspec/theme，
因此不会自动进入 Flutter Web 构建。后续须显式接入、保留许可、重新审计总包 64 MiB，
并实际验证 CanvasKit 中文字形和输入；不承诺全 Unicode/emoji、字体加载性能或手机可用。

独立解析复核已确认16张原始表、完整本地许可副本与上述大小/hash；双提取测试通过。
完整SC face不等于全Unicode或全部汉字：最佳cmap的Basic CJK覆盖20976/20992，
扩展A覆盖6582/6592，扩展B仅2108/42720；😀、U+20000与U+30000无映射。
这是静态字形映射检查，不是CanvasKit加载/渲染或回退网络行为的验收。
