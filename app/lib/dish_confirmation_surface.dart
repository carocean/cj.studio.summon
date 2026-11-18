import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:material_ui/material_ui.dart';

import 'dish_confirmation_contract.dart';
export 'dish_confirmation_contract.dart';

typedef DishConfirmationResponse = Future<DishConfirmation> Function(
  String interactionId,
  String choice,
);

/// On-demand confirmation only. The host must authenticate and revalidate every
/// response. No microphone, model text, web content, or automatic consent path.
class DishConfirmationSurface extends StatefulWidget {
  const DishConfirmationSurface({
    super.key,
    required this.contract,
    required this.access,
    required this.onRespond,
    this.onInvalidate,
    this.onResult,
  });
  final DishConfirmation contract;
  final ValueListenable<bool> access;
  final DishConfirmationResponse onRespond;

  /// Called only after the response has become terminal locally.
  final ValueChanged<DishConfirmation>? onResult;

  /// Best-effort host notification. UI invalidation never depends on its success.
  final void Function(String interactionId)? onInvalidate;
  @override
  State<DishConfirmationSurface> createState() =>
      _DishConfirmationSurfaceState();
}

class _DishConfirmationSurfaceState extends State<DishConfirmationSurface>
    with WidgetsBindingObserver {
  Timer? _timer;
  int _epoch = 0;
  bool _busy = false, _foreground = true;
  late DishConfirmation _contract;
  String? _localState;
  final Set<String> _retired = {};
  bool get _allowed => _foreground && widget.access.value;
  bool get _active => _contract.pending && _localState == null;
  @override
  void initState() {
    super.initState();
    _contract = widget.contract;
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
    widget.access.addListener(_accessChanged);
    _arm();
  }

  void _notifyRetired(void Function(String)? callback) {
    final id = _contract.interactionId;
    if (id != null && _retired.add(id)) {
      try {
        callback?.call(id);
      } catch (_) {
        /* Host TTL still applies. */
      }
    }
  }

  void _invalidate({String state = 'expired', bool notify = true}) {
    _timer?.cancel();
    _epoch++;
    _busy = false;
    _localState = state;
    if (notify) _notifyRetired(widget.onInvalidate);
  }

  void _arm() {
    _timer?.cancel();
    if (!_contract.pending) return;
    final remaining =
        _contract.expiresAt! - DateTime.now().millisecondsSinceEpoch;
    if (!_allowed ||
        remaining <= 0 ||
        _retired.contains(_contract.interactionId)) {
      _invalidate();
      return;
    }
    final epoch = _epoch;
    _timer = Timer(Duration(milliseconds: remaining), () {
      if (!mounted || epoch != _epoch) return;
      setState(() => _invalidate());
    });
  }

  void _accessChanged() {
    if (!widget.access.value && mounted) setState(() => _invalidate());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground && mounted) setState(() => _invalidate());
  }

  @override
  void didUpdateWidget(covariant DishConfirmationSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    final old = oldWidget.contract, next = widget.contract;
    final changed =
        old.state != next.state ||
        old.interactionId != next.interactionId ||
        old.expiresAt != next.expiresAt ||
        old.dishName != next.dishName ||
        oldWidget.access != widget.access ||
        oldWidget.onRespond != widget.onRespond;
    if (oldWidget.access != widget.access) {
      oldWidget.access.removeListener(_accessChanged);
      widget.access.addListener(_accessChanged);
    }
    if (changed) {
      _notifyRetired(oldWidget.onInvalidate);
      _invalidate(notify: false);
      _contract = next;
      _localState = null;
      _arm();
    }
  }

  Future<void> _respond(String choice) async {
    if (_busy || !_active) return;
    if (!_allowed ||
        _contract.expiresAt! <= DateTime.now().millisecondsSinceEpoch) {
      setState(() => _invalidate());
      return;
    }
    final epoch = _epoch, id = _contract.interactionId!;
    setState(() => _busy = true);
    try {
      final result = await widget.onRespond(id, choice);
      if (!mounted || epoch != _epoch || !_allowed) return;
      if (result.pending ||
          (choice == 'dismiss' && result.state == 'presented')) {
        throw const FormatException('invalid_confirmation_result');
      }
      _timer?.cancel();
      _retired.add(id);
      setState(() {
        _contract = result;
        _busy = false;
        _epoch++;
      });
      widget.onResult?.call(result);
    } catch (_) {
      if (!mounted || epoch != _epoch) return;
      setState(() => _invalidate(state: 'unavailable'));
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
    final state = _localState ?? _contract.state;
    const messages = {
      'presented': '已展开当前菜品说明。',
      'cancelled': '已取消，不展开说明。',
      'expired': '这次请求已失效，请重新提出。',
      'unavailable': '这次未能确认结果；不会自动重试。',
      'unrecognized': '这次没听明白，请重新提出。',
    };
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            state == 'pending'
                ? '要展开『${_contract.dishName}』的说明吗？'
                : messages[state]!,
            key: const Key('dish-confirmation-message'),
          ),
          if (state == 'pending')
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  key: const Key('dish-confirmation-show'),
                  onPressed: _busy ? null : () => _respond('show'),
                  child: const Text('展开说明'),
                ),
                TextButton(
                  key: const Key('dish-confirmation-dismiss'),
                  onPressed: _busy ? null : () => _respond('dismiss'),
                  child: const Text('不用了'),
                ),
              ],
            ),
          if (_busy) const Text('正在确认…'),
        ],
      ),
    );
  }
}
