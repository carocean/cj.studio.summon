import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:material_ui/material_ui.dart';

import 'dish_surface.dart';
import 'scene_experiment.dart';

/// Explicit host-requested synthetic presentation. No playback claims, microphone,
/// background polling, autonomous menu creation, or remote image acquisition.
class DishRemoteSurface extends StatefulWidget {
  const DishRemoteSurface({
    super.key,
    required this.api,
    required this.sessionId,
    required this.creatureId,
    required this.sceneRevision,
    required this.access,
  });
  final SceneExperimentApi api;
  final String sessionId, creatureId;
  final int sceneRevision;
  final ValueListenable<bool> access;
  @override
  State<DishRemoteSurface> createState() => _DishRemoteSurfaceState();
}

class _DishRemoteSurfaceState extends State<DishRemoteSurface>
    with WidgetsBindingObserver {
  DishView? _view;
  int _epoch = 0;
  bool _busy = false, _foreground = true;
  String? _error;
  bool get _allowed => _foreground && widget.access.value;
  @override
  void initState() {
    super.initState();
    widget.access.addListener(_accessChanged);
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    unawaited(_read());
  }

  void _clear() {
    _epoch++;
    if (mounted) {
      setState(() {
        _view = null;
        _busy = false;
        _error = '呈现已暂停，请重新打开；不会重发操作。';
      });
    }
  }

  void _accessChanged() {
    if (!widget.access.value) _clear();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground) _clear();
  }

  @override
  void didUpdateWidget(covariant DishRemoteSurface old) {
    super.didUpdateWidget(old);
    if (old.access != widget.access) {
      old.access.removeListener(_accessChanged);
      widget.access.addListener(_accessChanged);
    }
    if (old.sessionId != widget.sessionId ||
        old.api != widget.api ||
        old.creatureId != widget.creatureId ||
        old.sceneRevision != widget.sceneRevision ||
        old.access != widget.access) {
      _clear();
      unawaited(_read());
    }
  }

  bool _current(int epoch) => mounted && _allowed && epoch == _epoch;
  DishView _validated(Map<String, dynamic> raw, DishView? previous) {
    final v = DishView.parse(raw);
    if (v.sessionId != widget.sessionId ||
        v.creatureId != widget.creatureId ||
        v.sceneRevision != widget.sceneRevision ||
        (previous != null &&
            (v.taskId != previous.taskId ||
                v.catalogDigest != previous.catalogDigest ||
                v.dishId != previous.dishId ||
                v.revision != previous.revision + 1))) {
      throw const FormatException('dish_binding_changed');
    }
    return v;
  }

  Future<void> _read() async {
    if (!_allowed || _busy) return;
    final epoch = ++_epoch;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final raw = await widget.api.request('dish-read', {
        'sessionId': widget.sessionId,
      });
      if (!_current(epoch)) return;
      final v = _validated(raw, null);
      setState(() => _view = v);
    } catch (_) {
      if (_current(epoch)) setState(() => _error = '菜品呈现不可用，请重新打开。');
    } finally {
      if (_current(epoch)) setState(() => _busy = false);
    }
  }

  Future<void> _command(String kind, {String? direction}) async {
    final previous = _view;
    if (!_allowed || _busy || previous == null) return;
    if (!['details', 'image', 'zoom', 'hide'].contains(kind) ||
        (kind == 'zoom'
            ? !['in', 'out'].contains(direction)
            : direction != null)) {
      return;
    }
    final epoch = ++_epoch;
    setState(() => _busy = true);
    try {
      final raw = await widget.api.request('dish-command', {
        'sessionId': widget.sessionId,
        'command': {
          'kind': kind,
          'expectedRevision': previous.revision,
          'direction': ?direction,
        },
      });
      if (!_current(epoch)) return;
      final v = _validated(raw, previous);
      setState(() => _view = v);
    } catch (_) {
      if (_current(epoch)) {
        setState(() {
          _view = null;
          _error = '操作结果未知或已失效，请重新打开读取状态；不会自动重试。';
        });
      }
    } finally {
      if (_current(epoch)) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _epoch++;
    widget.access.removeListener(_accessChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('按需菜品呈现（合成验收）')),
    body: SafeArea(
      child: Column(
        children: [
          const Text('仅合成数据，无麦克风或真实语音播放。'),
          if (_busy)
            const LinearProgressIndicator(key: Key('dish-remote-busy')),
          if (_error != null)
            Text(_error!, key: const Key('dish-remote-error')),
          if (_view != null && _allowed)
            Expanded(
              child: AbsorbPointer(
                absorbing: _busy,
                child: DishSurface(
                  view: _view!,
                  onCommand: (kind, {direction}) {
                    unawaited(_command(kind, direction: direction));
                  },
                ),
              ),
            ),
        ],
      ),
    ),
  );
}
