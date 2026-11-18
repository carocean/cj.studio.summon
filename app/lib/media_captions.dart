import 'dart:async';

import 'package:material_ui/material_ui.dart';

import 'creature_registry.dart';

/// Host-owned ephemeral display, not sensor authorization or playback evidence.
/// The caller must feed refreshed authoritative scene state on context/revocation.
class BoundMediaCaptions extends ChangeNotifier {
  BoundMediaCaptions({this.lifetime = const Duration(seconds: 30)});
  final Duration lifetime;
  Map<String, dynamic>? _context;
  int? _generation;
  bool _hearing = false, _vision = false;
  int _round = 0;
  int? _deadline;
  Timer? _timer;
  bool _disposed = false, _foreground = true;
  void setForeground(bool foreground) {
    _foreground = foreground;
    if (!foreground) {
      clear();
      _context = null;
      _generation = null;
    }
  }

  String? userText, creatureText, userStatus, creatureStatus;
  String? _eventId, _reply, _modality;
  bool speaking = false;
  bool get visible => userStatus != null || creatureStatus != null;
  bool _same(dynamic frame) =>
      frame is Map &&
      frame.length == 2 &&
      frame['creatureId'] == _context?['creatureId'] &&
      frame['sceneRevision'] == _context?['sceneRevision'];
  void bind(Map<String, dynamic> state) {
    if (_disposed || !_foreground) return;
    final frame = state['context'];
    final c = registeredCreature(state, state['activeCreatureId']);
    if (frame is! Map ||
        frame.length != 2 ||
        frame['creatureId'] != state['activeCreatureId'] ||
        frame['sceneRevision'] is! int ||
        frame['sceneRevision'] < 1 ||
        frame['sceneRevision'] > 9007199254740991 ||
        c == null) {
      clear();
      _context = null;
      _generation = null;
      return;
    }
    final hearing = registeredSenseAllowed(c, 'hearing');
    final vision = registeredSenseAllowed(c, 'vision');
    if (!_same(frame) ||
        _generation != c['generation'] ||
        hearing != _hearing ||
        vision != _vision) {
      clear();
    }
    _context = Map<String, dynamic>.from(frame);
    _generation = c['generation'];
    _hearing = hearing;
    _vision = vision;
  }

  int? begin(Map frame, String modality) {
    if (_disposed ||
        !_foreground ||
        !_same(frame) ||
        !(modality == 'hearing' ? _hearing : modality == 'vision' && _vision)) {
      return null;
    }
    clear();
    _modality = modality;
    userStatus = modality == 'hearing' ? '正在识别语音…' : '正在处理图像…';
    _changed();
    return _round;
  }

  bool current(int? round) =>
      !_disposed &&
      _foreground &&
      round != null &&
      round == _round &&
      _context != null;
  bool accept(int? round, Map response, Map<String, dynamic>? validatedReply) {
    if (!current(round)) return false;
    final event = response['event'], result = response['result'];
    if (event is! Map ||
        result is! Map ||
        !_same(event['frame']) ||
        event['modality'] != _modality ||
        event['eventId'] is! String ||
        (event['eventId'] as String).isEmpty ||
        event['expiresAt'] is! int ||
        event['expiresAt'] <= DateTime.now().millisecondsSinceEpoch ||
        event['expiresAt'] > 9007199254740991 ||
        event['metadata'] is! Map ||
        event['metadata']['creatureGeneration'] != _generation ||
        event['metadata']['realProcessing'] != true ||
        result['realProcessing'] != true ||
        result['text'] is! String ||
        (result['text'] as String).length > 12000 ||
        ![
          'observation',
          'awaiting_confirmation',
          'awaiting_route_confirmation',
        ].contains(event['status']) ||
        !(event['modality'] == 'hearing'
            ? _hearing
            : event['modality'] == 'vision' && _vision)) {
      fail(round);
      return false;
    }
    _eventId = event['eventId'];
    _deadline = event['expiresAt'];
    userText = event['modality'] == 'hearing' ? result['text'] : null;
    userStatus = event['modality'] == 'hearing'
        ? (userText!.trim().isEmpty ? '没有识别到语音' : '语音识别结果（可能有误）')
        : '图像处理完成';
    // This text is only a future audio binding, never displayed as spoken yet.
    _reply =
        validatedReply?['eventId'] == _eventId &&
            validatedReply?['creatureId'] == _context?['creatureId'] &&
            validatedReply?['sceneRevision'] == _context?['sceneRevision'] &&
            validatedReply?['text'] is String &&
            (validatedReply!['text'] as String).length <= 600
        ? validatedReply['text'] as String?
        : null;
    _changed();
    return true;
  }

  void fail(int? round) {
    if (!current(round)) return;
    _round++;
    userText = null;
    creatureText = null;
    creatureStatus = null;
    speaking = false;
    _reply = null;
    _eventId = null;
    userStatus = '识别失败，未确认内容';
    _changed();
  }

  void voice(int? round, String eventId, String phase) {
    if (!current(round) || eventId != _eventId || _reply == null) return;
    if (_deadline != null &&
        DateTime.now().millisecondsSinceEpoch >= _deadline!) {
      clear();
      return;
    }
    if (phase == 'preparing') creatureText = null;
    speaking = phase == 'playing';
    if (speaking) creatureText = _reply;
    creatureStatus = switch (phase) {
      'preparing' => '正在合成语音…',
      'playing' => '生物正在说',
      'completed' => '播放完成（不代表已被听到）',
      'paused' => '语音已暂停',
      'stopped' => '语音已停止',
      'failed' => '语音合成或播放失败',
      _ => '播放器尚未确认播放',
    };
    _changed();
  }

  void _changed() {
    _timer?.cancel();
    final remaining = _deadline == null
        ? lifetime
        : Duration(
            milliseconds: _deadline! - DateTime.now().millisecondsSinceEpoch,
          );
    _timer = Timer(remaining < lifetime ? remaining : lifetime, clear);
    notifyListeners();
  }

  void clear() {
    if (_disposed) return;
    _round++;
    _deadline = null;
    _timer?.cancel();
    _timer = null;
    userText = creatureText = userStatus = creatureStatus = _eventId = _reply =
        null;
    speaking = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }
}

class MediaCaptionView extends StatelessWidget {
  const MediaCaptionView({super.key, required this.captions});
  final BoundMediaCaptions captions;
  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      if (captions.userStatus != null)
        Text(captions.userStatus!, key: const Key('media-user-status')),
      if (captions.userText?.isNotEmpty == true)
        Text(
          captions.userText!,
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
          key: const Key('media-user-caption'),
        ),
      if (captions.creatureStatus != null)
        Text(captions.creatureStatus!, key: const Key('media-creature-status')),
      if (captions.creatureText != null)
        Text(
          captions.creatureText!,
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
          key: const Key('media-creature-caption'),
        ),
    ],
  );
}
