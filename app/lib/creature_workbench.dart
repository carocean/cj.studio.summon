import 'handoff_sheet.dart';
import 'scene_text_entry.dart';
import 'focus_sheet.dart';
import 'route_voice.dart';
import 'creature_market.dart';

import 'dart:math' as math;

import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;

import 'scene_experiment.dart';
import 'perception_home.dart';
import 'creature_sense.dart';
import 'creature_registry.dart';
import 'perception_capture.dart';

/// Explicit development workbench. Never the default user entry surface.
class CreatureWorkbench extends StatefulWidget {
  const CreatureWorkbench({
    super.key,
    this.client,
    this.developerConsole,
    this.senseCaptureFactory,
  });
  final http.Client? client;
  final WidgetBuilder? developerConsole;
  final SenseCapture Function()? senseCaptureFactory;
  @override
  State<CreatureWorkbench> createState() => _CreatureWorkbenchState();
}

class _CreatureWorkbenchState extends State<CreatureWorkbench> {
  late final http.Client _client;
  late final SceneExperimentApi _api;
  Map<String, dynamic>? _state;
  bool _busy = false;
  String? _error;
  int _workbenchEpoch = 0;
  final FocusRecovery _focusRecovery = FocusRecovery();
  Map<String, dynamic>? get _current =>
      registeredCreature(_state, _state?['activeCreatureId']);
  String get _name => _current?['name'] ?? '生物预览';
  bool get _work {
    if (_current?['id'] != 'work' ||
        _current?['body'] != 'owl' ||
        _current?['tone'] != 'precise') {
      return false;
    }
    final declaration = _state?['presentation'];
    if (declaration is Map && declaration['schema'] == 'creature-scene.v1') {
      return declaration['context'] == 'work' &&
          declaration['creatureId'] == 'work' &&
          _state?['activeCreatureId'] == 'work';
    }
    return _state?['activeCreatureId'] == 'work';
  }

  bool get _trustedWorkbench {
    if (!_work) return false;
    final d = _state?['presentation'];
    final task = _state?['activity'];
    return d is Map &&
        d['schema'] == 'creature-scene.v1' &&
        d['body'] == 'owl' &&
        d['tone'] == 'precise' &&
        d['context'] == 'work' &&
        d['creatureId'] == 'work' &&
        task is Map &&
        d['activityId'] == task['id'] &&
        (d['activityRevision'] is int &&
            d['activityRevision'] == task['revision']) &&
        d['source'] == 'deterministic-policy' &&
        (d['surface'] == 'synthetic-account' ||
            (d['surface'] == 'task-summary' && task['sceneVisible'] != true)) &&
        (d['surface'] != 'synthetic-account' || task['sceneVisible'] == true);
  }

  @override
  void initState() {
    super.initState();
    _client = widget.client ?? http.Client();
    _api = SceneExperimentApi(_client);
    _load();
  }

  Future<void> _load([
    String action = 'state',
    Map<String, dynamic>? body,
  ]) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _workbenchEpoch++;
    });
    final requestEpoch = _workbenchEpoch;
    try {
      final state = await _api.request(action, body);
      if (mounted && requestEpoch == _workbenchEpoch) {
        setState(() {
          _state = state;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _error = '本机情境服务未连接。生物动画仍可预览，任务与情境切换尚未确认。');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _perceive(String modality) async {
    final creatureId = _state?['activeCreatureId'];
    if (_busy ||
        _current == null ||
        !registeredSenseAllowed(_current, modality)) {
      return;
    }
    setState(() {
      _state = _state == null ? null : ({..._state!}..remove('textEntry'));
      _workbenchEpoch++;
    });
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => CreatureSenseSheet(
          creatureId: creatureId,
          creatureName: _name,
          modality: modality,
          client: _client,
          capture: widget.senseCaptureFactory?.call(),
        ),
      ),
    );
    if (mounted) await _load();
  }

  Future<void> _legacyPerception() async {
    setState(() {
      _state = _state == null ? null : ({..._state!}..remove('textEntry'));
      _workbenchEpoch++;
    });
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) =>
            PerceptionHome(developerConsole: widget.developerConsole),
      ),
    );
    if (mounted) await _load();
  }

  Future<void> _focus() async {
    if (_busy) return;
    setState(() {
      _state = _state == null ? null : ({..._state!}..remove('textEntry'));
      _workbenchEpoch++;
    });
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => FractionallySizedBox(
        heightFactor: .85,
        child: FocusSheet(client: _client, recovery: _focusRecovery),
      ),
    );
    if (mounted) await _load();
  }

  Future<void> _handoffs() async {
    if (_busy) return;
    setState(() {
      _state = _state == null ? null : ({..._state!}..remove('textEntry'));
      _workbenchEpoch++;
    });
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => FractionallySizedBox(
        heightFactor: .9,
        child: HandoffSheet(client: _client),
      ),
    );
    if (mounted) await _load();
  }

  Future<void> _partners() async {
    if (_busy) return;
    setState(() {
      _state = _state == null ? null : ({..._state!}..remove('textEntry'));
      _workbenchEpoch++;
    });
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (_) => FractionallySizedBox(
        heightFactor: .85,
        child: CreatureRegistrySheet(client: _client),
      ),
    );
    if (mounted) await _load();
  }

  Future<void> _engineering() async {
    setState(() {
      _state = _state == null ? null : ({..._state!}..remove('textEntry'));
      _workbenchEpoch++;
    });
    await Navigator.of(
      context,
    ).push(MaterialPageRoute(builder: (_) => SceneExperiment(client: _client)));
    if (mounted) await _load();
  }

  @override
  void dispose() {
    if (widget.client == null) _client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final callbackEpoch = _workbenchEpoch;
    final task = _state?['activity'];
    final hasTask = task is Map;
    final route = trustedRoute(_state);
    final textEntry = trustedTextEntry(_state);
    return Scaffold(
      backgroundColor: _work
          ? const Color(0xffeef1fb)
          : const Color(0xfff3f5ec),
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: const Text('Summon'),
        actions: [
          IconButton(
            key: const Key('creature-partners'),
            tooltip: '我的伙伴',
            icon: const Icon(Icons.people_outline),
            onPressed: _busy ? null : _partners,
          ),
          PopupMenuButton<String>(
            key: const Key('creature-menu'),
            tooltip: '开发与连接',
            onSelected: (value) {
              if (value == 'legacy-sense') {
                _legacyPerception();
              } else if (value == 'handoffs') {
                _handoffs();
              } else if (value == 'lab') {
                _engineering();
              } else {
                _load();
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'handoffs', child: Text('核对生物交接历史')),
              PopupMenuItem(value: 'refresh', child: Text('刷新本机情境')),
              PopupMenuItem(value: 'lab', child: Text('开发：合成情境工程台')),
              PopupMenuItem(value: 'legacy-sense', child: Text('开发：旧主体感知页')),
            ],
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                _work ? '工作空间' : '日常空间',
                style: Theme.of(context).textTheme.labelLarge,
              ),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 450),
                child: CreatureAvatar(
                  key: ValueKey(_current?['id']),
                  work: _current?['body'] == 'owl',
                  precise: _current?['tone'] == 'precise',
                  name: _name,
                ),
              ),
              Text(
                _name,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.headlineLarge,
              ),
              Text(
                _current?['personality'] ?? '离线外形预览，当前生物尚未确认。',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodyLarge,
              ),
              if (_current != null &&
                  _current!['id'] == _state?['primaryCreatureId'])
                const Text('你的主生物', textAlign: TextAlign.center),
              if (_current != null &&
                  _current!['id'] == _state?['primaryCreatureId'])
                OutlinedButton(
                  key: const Key('creature-focus'),
                  onPressed: _busy ? null : _focus,
                  child: const Text('一起专注（本机演示）'),
                ),
              if (_focusRecovery.requestId != null &&
                  _current?['id'] != _state?['primaryCreatureId'])
                TextButton(
                  onPressed: _busy ? null : _focus,
                  child: const Text('核对未确认的专注请求'),
                ),
              if (canPrepareHandoff(_state))
                OutlinedButton(
                  key: const Key('creature-handoff'),
                  onPressed: _busy ? null : _handoffs,
                  child: const Text('协调工作伙伴（合成草稿）'),
                ),
              const SizedBox(height: 16),
              const Text(
                '可触碰的生物呈现原型 · 呼吸、眨眼是本地动画，不表示已经听见或看见。',
                textAlign: TextAlign.center,
              ),
              if (_busy) const LinearProgressIndicator(),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(_error!, key: const Key('creature-offline')),
                ),
              const SizedBox(height: 20),
              Row(
                children: [
                  Expanded(
                    child: FilledButton.icon(
                      key: const Key('creature-hear'),
                      onPressed:
                          _busy || !registeredSenseAllowed(_current, 'hearing')
                          ? null
                          : () => _perceive('hearing'),
                      icon: const Icon(Icons.mic_none),
                      label: const Text('用声音呼唤'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: OutlinedButton.icon(
                      key: const Key('creature-see'),
                      onPressed:
                          _busy || !registeredSenseAllowed(_current, 'vision')
                          ? null
                          : () => _perceive('vision'),
                      icon: const Icon(Icons.visibility_outlined),
                      label: const Text('一起看看'),
                    ),
                  ),
                ],
              ),
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 10),
                child: Text(
                  '采集绑定当前生物，媒体另行确认后才发送到本机。听觉情境建议须再次确认；图片只作观察。',
                  textAlign: TextAlign.center,
                ),
              ),
              if (textEntry == null)
                TextButton(
                  key: const Key('creature-text'),
                  onPressed: _busy || _state?['context'] is! Map
                      ? null
                      : () => _load('text-entry', {
                          'context': _state!['context'],
                          'visible': true,
                        }),
                  child: const Text('改用文字'),
                ),
              if (textEntry != null && !_busy)
                SceneTextEntry(
                  key: ValueKey('text-$_workbenchEpoch'),
                  api: _api,
                  frame: textEntry,
                  onState: (state) {
                    if (mounted && !_busy && callbackEpoch == _workbenchEpoch) {
                      setState(() {
                        _state = state;
                        _workbenchEpoch++;
                      });
                    }
                  },
                ),
              TextButton(
                key: const Key('creature-demo'),
                onPressed: _busy
                    ? null
                    : () => _load('perceive', {
                        'modality': 'hearing',
                        'signal': _work ? 'personal-context' : 'work-context',
                      }),
                child: Text(_work ? '回到小伴 · 合成情境预览' : '认识工作伙伴 · 合成情境预览'),
              ),
              if (_work)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          '小谨的工作台',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const Text('合成业务预览，不会开立账户或联系银行。'),
                        if (!hasTask)
                          FilledButton(
                            key: const Key('creature-request-form'),
                            onPressed: _busy
                                ? null
                                : () => _load('perceive', {
                                    'modality': 'hearing',
                                    'signal': 'account-request',
                                  }),
                            child: const Text('预览按需生成的表单'),
                          ),
                        if (hasTask && _trustedWorkbench && !_busy)
                          SizedBox(
                            height: 620,
                            child: SceneExperiment(
                              key: ValueKey('workbench-$_workbenchEpoch'),
                              client: _client,
                              workbenchOnly: true,
                              onStateChanged: (state) {
                                if (mounted &&
                                    !_busy &&
                                    callbackEpoch == _workbenchEpoch) {
                                  setState(() => _state = state);
                                }
                              },
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              if (route != null)
                RouteVoiceControl(state: _state!, api: _api, disabled: _busy),
              if (route != null)
                SyntheticRouteCard(
                  route: route,
                  busy: _busy,
                  onVisibility: (v) => _load('route-visible', {
                    'receiptId': route['receipt']['receiptId'],
                    'visible': v,
                  }),
                ),
              if ((!_work || !_trustedWorkbench) && hasTask)
                const Card(
                  child: Padding(
                    padding: EdgeInsets.all(16),
                    child: Text('小谨仍保留着工作任务。切回工作情境后可继续，个人空间不会显示工作字段。'),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class CreatureAvatar extends StatefulWidget {
  const CreatureAvatar({
    super.key,
    required this.work,
    required this.precise,
    required this.name,
  });
  final bool work, precise;
  final String name;
  @override
  State<CreatureAvatar> createState() => _CreatureAvatarState();
}

class _CreatureAvatarState extends State<CreatureAvatar>
    with SingleTickerProviderStateMixin {
  late final AnimationController _breath;
  bool _touched = false;
  @override
  void initState() {
    super.initState();
    _breath = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 4),
    )..repeat();
  }

  @override
  void dispose() {
    _breath.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
    label: '${widget.name}，${widget.precise ? '沉稳' : '好奇'}的生物',
    button: true,
    child: GestureDetector(
      key: const Key('creature-touch'),
      onTap: () => setState(() => _touched = !_touched),
      child: SizedBox(
        height: 260,
        child: Stack(
          alignment: Alignment.center,
          children: [
            AnimatedBuilder(
              animation: _breath,
              builder: (_, _) => CustomPaint(
                size: const Size(300, 240),
                painter: CreaturePainter(
                  work: widget.work,
                  precise: widget.precise,
                  phase: _breath.value,
                  touched: _touched,
                ),
              ),
            ),
            if (_touched)
              const Positioned(
                bottom: 0,
                child: Text('我在这里。', key: Key('creature-touch-feedback')),
              ),
          ],
        ),
      ),
    ),
  );
}

class CreaturePainter extends CustomPainter {
  CreaturePainter({
    required this.work,
    required this.precise,
    required this.phase,
    required this.touched,
  });
  final bool work, touched, precise;
  final double phase;
  @override
  void paint(Canvas canvas, Size size) {
    final breathe = math.sin(phase * 2 * math.pi);
    final cx = size.width / 2, cy = size.height / 2 + 8;
    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(cx, 221),
        width: 128 + breathe * 5,
        height: 16,
      ),
      Paint()..color = const Color(0x19234240),
    );
    canvas.save();
    canvas.translate(cx, cy + breathe * (precise ? 2 : 5));
    final body = Paint()
      ..shader = LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: work
            ? [const Color(0xff7c91d2), const Color(0xff3c508a)]
            : [const Color(0xffbbdb8a), const Color(0xff5d9871)],
      ).createShader(const Rect.fromLTWH(-90, -90, 180, 180));
    if (work) {
      final ears = Path()
        ..moveTo(-72, -30)
        ..lineTo(-75, -103)
        ..lineTo(-27, -70)
        ..moveTo(72, -30)
        ..lineTo(75, -103)
        ..lineTo(27, -70);
      canvas.drawPath(ears, body);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromCenter(
            center: Offset.zero,
            width: 154,
            height: 158 + breathe * 3,
          ),
          const Radius.circular(42),
        ),
        body,
      );
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          const Rect.fromLTWH(-30, -96, 60, 20),
          const Radius.circular(10),
        ),
        Paint()..color = const Color(0xffb7c3ed),
      );
    } else {
      final shape = Path()
        ..moveTo(-76, 20)
        ..cubicTo(-100, -40, -55, -94, -10, -80)
        ..cubicTo(32, -111, 82, -67, 83, -10)
        ..cubicTo(108, 52, 54, 85, 0, 80)
        ..cubicTo(-42, 90, -86, 67, -76, 20);
      canvas.drawPath(shape, body);
      canvas.drawOval(
        Rect.fromCenter(center: const Offset(-38, -88), width: 24, height: 42),
        Paint()..color = const Color(0xff91b96c),
      );
    }
    final blink = phase > .92 || touched;
    final ink = Paint()
      ..color = const Color(0xff203640)
      ..strokeWidth = 5
      ..strokeCap = StrokeCap.round;
    for (final x in [-29.0, 29.0]) {
      if (blink) {
        canvas.drawLine(Offset(x - 7, -12), Offset(x + 7, -12), ink);
      } else {
        canvas.drawOval(
          Rect.fromCenter(center: Offset(x, -12), width: 12, height: 19),
          ink,
        );
        canvas.drawCircle(
          Offset(x + 2, -16),
          2.5,
          Paint()..color = Colors.white,
        );
      }
    }
    canvas.drawArc(
      const Rect.fromLTWH(-13, 6, 26, 18),
      0,
      math.pi,
      false,
      ink
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3,
    );
    if (work) {
      canvas.drawLine(
        const Offset(-55, -28),
        const Offset(-8, -28),
        ink
          ..color = const Color(0xffd5e2ff)
          ..strokeWidth = 2,
      );
      canvas.drawLine(const Offset(8, -28), const Offset(55, -28), ink);
    } else {
      canvas.drawCircle(
        const Offset(-48, 5),
        9,
        Paint()..color = const Color(0x66f8d3a1),
      );
      canvas.drawCircle(
        const Offset(48, 5),
        9,
        Paint()..color = const Color(0x66f8d3a1),
      );
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(CreaturePainter old) =>
      old.phase != phase ||
      old.work != work ||
      old.precise != precise ||
      old.touched != touched;
}
