import 'dart:async';
import 'dart:typed_data';

import 'package:material_ui/material_ui.dart';

import 'creature_market.dart';
import 'creature_voice.dart';
import 'scene_experiment.dart';

Uint8List? validatedRouteVoice(dynamic raw, String receiptId, Map context) {
  const keys = {
    'schema',
    'receiptId',
    'context',
    'mimeType',
    'base64',
    'engine',
    'model',
    'realProcessing',
  };
  if (raw is! Map ||
      raw.length != keys.length ||
      !raw.keys.every(keys.contains) ||
      raw['schema'] != 'route-voice.v1' ||
      raw['receiptId'] != receiptId) {
    return null;
  }
  // Only the validated identity envelope is translated; shared WAV size/format rules stay identical.
  return validatedCreatureVoice(
    {...raw, 'schema': 'creature-voice.v1', 'eventId': raw['receiptId']}
      ..remove('receiptId'),
    {'eventId': receiptId},
    context,
  );
}

class RouteVoiceControl extends StatefulWidget {
  const RouteVoiceControl({
    super.key,
    required this.state,
    required this.api,
    this.player,
    this.disabled = false,
  });
  final Map<String, dynamic> state;
  final SceneExperimentApi api;
  final CreatureVoicePlayer? player;
  final bool disabled;
  @override
  State<RouteVoiceControl> createState() => _RouteVoiceControlState();
}

class _RouteVoiceControlState extends State<RouteVoiceControl>
    with WidgetsBindingObserver {
  late final CreatureVoicePlayer _player;
  int _epoch = 0;
  bool _busy = false, _suspended = false;
  String? _message;
  String get _binding =>
      '${widget.state['context']}|${widget.state['route']?['receipt']?['receiptId']}';
  bool get _valid {
    final context = widget.state['context'], route = trustedRoute(widget.state);
    return widget.state['voiceAvailable'] == true &&
        route != null &&
        context is Map &&
        context.length == 2 &&
        context['creatureId'] == route['receipt']['instanceId'] &&
        context['sceneRevision'] is int &&
        context['sceneRevision'] >= 0;
  }

  @override
  void initState() {
    super.initState();
    _player = widget.player ?? GenerationVoicePlayer();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (ModalRoute.of(context)?.isCurrent == false) {
      unawaited(_stop());
      _busy = false;
    }
  }

  Future<void> _stop() async {
    _epoch++;
    await _player.stop().catchError((_) {});
  }

  @override
  void didUpdateWidget(covariant RouteVoiceControl oldWidget) {
    super.didUpdateWidget(oldWidget);
    final old =
        '${oldWidget.state['context']}|${oldWidget.state['route']?['receipt']?['receiptId']}';
    if (old != _binding || widget.disabled || !_valid) {
      unawaited(_stop());
      _busy = false;
      _message = null;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) {
      _suspended = true;
      unawaited(_stop());
      if (mounted) setState(() => _busy = false);
    } else if (mounted) {
      setState(() => _suspended = false);
    }
  }

  Future<void> _speak() async {
    if (!_valid || _busy || widget.disabled || _suspended) return;
    final epoch = ++_epoch,
        context = Map<String, dynamic>.from(widget.state['context']),
        receiptId = widget.state['route']['receipt']['receiptId'] as String;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final response = await widget.api.request('route-speak', {
        'receiptId': receiptId,
        'context': context,
      });
      if (!mounted || epoch != _epoch || widget.disabled || _suspended) return;
      final bytes = validatedRouteVoice(response, receiptId, context);
      if (bytes == null) throw StateError('invalid_route_voice');
      await _player.play(bytes);
      if (mounted && epoch == _epoch) {
        setState(() => _message = '此回执语音已交给本机播放器；不会自动重播。');
      }
    } catch (_) {
      if (mounted && epoch == _epoch) {
        await _stop();
        if (mounted) {
          setState(() {
            _message = '合成或播放未确认，不自动重试。';
            _busy = false;
          });
        }
      }
    } finally {
      if (mounted && epoch == _epoch) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _epoch++;
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_player.dispose().catchError((_) {}));
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_valid) return const SizedBox.shrink();
    return Column(
      children: [
        OutlinedButton(
          key: const Key('route-speak'),
          onPressed: _busy || widget.disabled || _suspended ? null : _speak,
          child: const Text('朗读此回执（本机合成）'),
        ),
        TextButton(
          onPressed: () => _stop().then((_) {
            if (mounted) setState(() => _busy = false);
          }),
          child: const Text('停止回执朗读'),
        ),
        if (_message != null) Text(_message!),
      ],
    );
  }
}
