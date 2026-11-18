import 'dart:math' as math;

import 'package:material_ui/material_ui.dart';

import 'interaction_contract.dart';
import 'reading_contract.dart';

/// Explicitly supplied local demonstration only. No Home entry, network, model,
/// authentication, save, page-number state, or mutation of caller-owned progress.
class ReadingSurface extends StatefulWidget {
  const ReadingSurface({
    super.key,
    required this.resource,
    required this.readingState,
    required this.fontCapabilities,
  });
  final Map<String, dynamic> resource, readingState, fontCapabilities;
  @override
  State<ReadingSurface> createState() => _ReadingSurfaceState();
}

class _ReadingSurfaceState extends State<ReadingSurface>
    with WidgetsBindingObserver {
  final _scroll = ScrollController();
  int _epoch = 0;
  String? _layout;
  bool _foreground = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
  }

  @override
  void didUpdateWidget(ReadingSurface old) {
    super.didUpdateWidget(old);
    _epoch++;
    _layout = null;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _epoch++;
    _layout = null;
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    _scroll.dispose();
    super.dispose();
  }

  Widget _message(String value) => SingleChildScrollView(
    padding: const EdgeInsets.all(16),
    child: Text(value, key: const Key('reading-unsupported')),
  );
  @override
  Widget build(BuildContext context) {
    final r = validatedReadingResource(widget.resource),
        s = validatedReadingState(widget.resource, widget.readingState);
    final route = ModalRoute.of(context), current = route?.isCurrent ?? true;
    Widget body;
    if (r == null || s == null) {
      _epoch++;
      _layout = null;
      body = _message('资源或阅读状态无效；不会替换原位置。');
    } else {
      final p = s['presentation'];
      if (!readingFontAvailable(p, widget.fontCapabilities) ||
          p['fontRef'] != 'SummonPreviewSC') {
        _epoch++;
        _layout = null;
        body = _message('此字体当前不支持；保留原阅读状态，不自动换字体。');
      } else if (p['flow'] != 'scroll' || p['pageControls'] == true) {
        _epoch++;
        _layout = null;
        body = _message('分页与翻页控件尚未实现；此演示仅支持明确选择的滚动阅读。');
      } else {
        final background = Color(
          0xff000000 |
              int.parse((p['background'] as String).substring(1), radix: 16),
        );
        final foreground = background.computeLuminance() > 0.179
            ? Colors.black
            : Colors.white;
        final style = TextStyle(
          fontFamily: 'SummonPreviewSC',
          fontSize: 18 * p['textScalePermille'] / 1000,
          height: 1.6,
          color: foreground,
        );
        final blocks = r['blocks'] as List;
        final text = blocks.map((b) => b['text'] as String).join('\n\n');
        var anchorOffset = 0;
        for (final b in blocks) {
          if (b['id'] == s['anchor']['blockId']) {
            anchorOffset += readingScalarToUtf16(
              b['text'],
              s['anchor']['scalarOffset'],
            );
            break;
          }
          anchorOffset += (b['text'] as String).length + 2;
        }
        final span = TextSpan(text: text, style: style),
            scaler = MediaQuery.textScalerOf(context),
            direction = Directionality.of(context);
        body = ColoredBox(
          color: background,
          child: LayoutBuilder(
            builder: (context, box) {
              final width = math.max(1.0, box.maxWidth - 32),
                  height = box.maxHeight;
              final signature =
                  '${interactionCanonical(s)}|${box.maxWidth}|$height|${scaler.scale(style.fontSize!)}|$direction|$current|$_foreground';
              if (signature != _layout) {
                _layout = signature;
                final epoch = ++_epoch;
                final painter = TextPainter(
                  text: span,
                  textDirection: direction,
                  textScaler: scaler,
                )..layout(maxWidth: width);
                final position = painter.getOffsetForCaret(
                  TextPosition(offset: anchorOffset),
                  Rect.zero,
                );
                final lineHeight = painter.preferredLineHeight;
                painter.dispose();
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (!mounted ||
                      epoch != _epoch ||
                      _layout != signature ||
                      !_foreground ||
                      !current ||
                      (route != null && !route.isCurrent) ||
                      !_scroll.hasClients) {
                    return;
                  }
                  final target =
                      (position.dy +
                              16 -
                              math.max(0, (height - lineHeight) / 3))
                          .clamp(0.0, _scroll.position.maxScrollExtent);
                  _scroll.jumpTo(target);
                });
              }
              return SingleChildScrollView(
                key: const Key('reading-viewport'),
                controller: _scroll,
                padding: const EdgeInsets.all(16),
                child: SizedBox(
                  width: width,
                  child: RichText(
                    key: const Key('reading-text'),
                    text: span,
                    textDirection: direction,
                    textScaler: scaler,
                  ),
                ),
              );
            },
          ),
        );
      }
    }
    return Scaffold(
      appBar: AppBar(title: const Text('只读本地阅读演示')),
      body: LayoutBuilder(
        builder: (context, constraints) => Column(
          children: [
            ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: constraints.maxHeight * .4,
              ),
              child: const SingleChildScrollView(
                child: Padding(
                  padding: EdgeInsets.all(12),
                  child: Text(
                    '仅显示显式提供的本地文本。尚未保存阅读进度；来源声明不等于已取得或已核验。',
                    key: Key('reading-demo-notice'),
                  ),
                ),
              ),
            ),
            Expanded(child: body),
          ],
        ),
      ),
    );
  }
}
