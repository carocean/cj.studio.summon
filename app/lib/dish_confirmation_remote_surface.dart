import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:material_ui/material_ui.dart';

import 'dish_confirmation_surface.dart';
import 'dish_contract.dart';
import 'scene_experiment.dart';

/// Explicitly mounted protected-preview experiment, not the default home.
/// The injected API must use the existing protected session transport.
class DishConfirmationRemoteSurface extends StatefulWidget {
  const DishConfirmationRemoteSurface({
    super.key,
    required this.api,
    required this.access,
    required this.sessionId,
    required this.onSwitchRequest,
  });
  final SceneExperimentApi api;

  /// Host-selected session, never model-supplied.
  final String sessionId;
  final VoidCallback onSwitchRequest;
  final ValueListenable<bool> access;
  @override
  State<DishConfirmationRemoteSurface> createState() =>
      _DishConfirmationRemoteSurfaceState();
}

class _DishConfirmationRemoteSurfaceState
    extends State<DishConfirmationRemoteSurface>
    with WidgetsBindingObserver {
  DishConfirmation? _contract;
  DishView? _binding, _validatedDetails, _details;
  String? _error;
  bool _retired = false, _foreground = true;
  int _epoch = 0;
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

  bool _active(int epoch) =>
      mounted &&
      !_retired &&
      epoch == _epoch &&
      widget.access.value &&
      _foreground;
  void _requireActive(int epoch) {
    if (!_active(epoch)) throw StateError('confirmation_retired');
  }

  bool _sameDish(DishView a, DishView b) =>
      a.sessionId == b.sessionId &&
      a.taskId == b.taskId &&
      a.dishId == b.dishId &&
      a.catalogDigest == b.catalogDigest &&
      a.creatureId == b.creatureId &&
      a.sceneRevision == b.sceneRevision &&
      a.lastSpeechSequence == b.lastSpeechSequence &&
      a.name == b.name &&
      a.speechPhase == b.speechPhase;
  Future<void> _read() async {
    if (!widget.access.value || !_foreground) {
      _invalidate();
      return;
    }
    final epoch = _epoch;
    try {
      if (!RegExp(r'^[A-Za-z][A-Za-z0-9.-]{0,63}$').hasMatch(widget.sessionId)) {
        throw const FormatException('invalid_dish_session');
      }
      final result = DishConfirmation.parse(
        await widget.api.request('dish-confirmation-read', {}),
      );
      _requireActive(epoch);
      if (result.pending) {
        final view = DishView.parse(
          await widget.api.request('dish-read', {
            'sessionId': widget.sessionId,
          }),
        );
        _requireActive(epoch);
        if (view.sessionId != widget.sessionId ||
            view.view != 'none' ||
            view.speechPhase != 'stopped' ||
            view.dishId == null ||
            view.name != result.dishName) {
          throw const FormatException('dish_confirmation_binding_changed');
        }
        _binding = view;
      } else if (result.state == 'presented') {
        // A reopened surface has no locally-bound confirmation receipt.
        throw const FormatException('dish_confirmation_receipt_missing');
      }
      setState(() => _contract = result);
    } catch (_) {
      if (_active(epoch)) {
        _invalidate();
        setState(() => _error = '这次未能读取确认请求；不会自动重试。');
      }
    }
  }

  Future<DishConfirmation> _respond(String id, String choice) async {
    final epoch = _epoch, before = _binding;
    _requireActive(epoch);
    if (before == null || !_contract!.pending || id != _contract!.interactionId) {
      throw StateError('confirmation_binding_missing');
    }
    final result = DishConfirmation.parse(
      await widget.api.request('dish-confirmation-respond', {
        'interactionId': id,
        'choice': choice,
      }),
    );
    _requireActive(epoch);
    if (result.state == 'presented') {
      if (choice != 'show') throw StateError('unexpected_confirmation_result');
      final after = DishView.parse(
        await widget.api.request('dish-read', {'sessionId': widget.sessionId}),
      );
      _requireActive(epoch);
      if (!_sameDish(before, after) ||
          after.view != 'details' ||
          after.speechPhase != 'stopped' ||
          after.revision != before.revision + 1 ||
          after.description != before.description ||
          after.imageRef != before.imageRef) {
        throw const FormatException('dish_details_binding_changed');
      }
      // Do not replace the pending child before it consumes its terminal result.
      _validatedDetails = after;
    }
    return result;
  }

  void _result(DishConfirmation result) {
    if (!_active(_epoch)) return;
    if (result.state == 'presented' && _validatedDetails != null) {
      setState(() {
        _details = _validatedDetails;
        _contract = result;
      });
    }
  }

  void _switchRequest() {
    _invalidate();
    widget.onSwitchRequest();
  }

  void _invalidate([String? ignoredId]) {
    if (_retired) return;
    _retired = true;
    _epoch++;
    _binding = null;
    _validatedDetails = null;
    _details = null;
    final api = widget.api;
    // May be called by a child during unmount; do not setState in build/dispose.
    scheduleMicrotask(() async {
      if (mounted) {
        setState(() {
          _contract = null;
        });
      }
      try {
        await api.request('dish-confirmation-invalidate', {});
      } catch (_) {
        if (mounted) setState(() => _error = '本机确认已关闭；尚未确认服务器撤销，不会重试。');
      }
    });
  }

  void _accessChanged() {
    if (!widget.access.value) _invalidate();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground) _invalidate();
  }

  @override
  void didUpdateWidget(covariant DishConfirmationRemoteSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.access != widget.access) {
      oldWidget.access.removeListener(_accessChanged);
      widget.access.addListener(_accessChanged);
    }
    if (oldWidget.api != widget.api ||
        oldWidget.access != widget.access ||
        oldWidget.sessionId != widget.sessionId ||
        oldWidget.onSwitchRequest != widget.onSwitchRequest) {
      // A remote surface never rebinds to another owner/session in place.
      if (!_retired) {
        _retired = true;
        _epoch++;
        _contract = null;
        _binding = null;
        _validatedDetails = null;
        _details = null;
        unawaited(
          oldWidget.api.request('dish-confirmation-invalidate', {}).catchError((
            Object _,
          ) {
            if (mounted) setState(() => _error = '本机确认已关闭；尚未确认服务器撤销，不会重试。');
            return <String, dynamic>{};
          }),
        );
      }
    }
  }

  @override
  void dispose() {
    _invalidate();
    widget.access.removeListener(_accessChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    Widget body;
    if (_error != null) {
      body = Text(_error!);
    } else if (_retired) {
      body = const Text('本机界面已关闭；已提交的结果不会因此撤销。');
    } else if (_details != null) {
      body = Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('已展开当前菜品说明。'),
          Text(_details!.name!, key: const Key('confirmed-dish-name')),
          const Text('合成演示 · 非真实菜单'),
          Text(
            _details!.description ?? '暂无菜品说明',
            key: const Key('confirmed-dish-description'),
          ),
        ],
      );
    } else if (_contract == null) {
      body = const Text('正在读取确认请求…');
    } else {
      body = DishConfirmationSurface(
        contract: _contract!,
        access: widget.access,
        onRespond: _respond,
        onInvalidate: _invalidate,
        onResult: _result,
      );
    }
    return SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          body,
          if (!_retired)
            TextButton(
              onPressed: _switchRequest,
              child: const Text('切换需求 / 收起'),
            ),
        ],
      ),
    );
  }
}
