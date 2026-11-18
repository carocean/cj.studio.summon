import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';

import 'voice_source.dart';

enum VoicePlaybackPhase { playing, paused, stopped, completed, failed }

abstract class ObservableVoicePlayback {
  Stream<VoicePlaybackPhase> get playbackStates;
}

abstract class CreatureVoicePlayer {
  Future<void> play(Uint8List wav);
  Future<void> stop();
  Future<void> dispose();
}

abstract class VoicePlaybackBackend {
  Future<void> load(Uint8List wav);
  Future<void> resume();
  Future<void> stop();
  Future<void> dispose();
}

class AudioplayersVoiceBackend
    implements VoicePlaybackBackend, ObservableVoicePlayback {
  final _events = StreamController<VoicePlaybackPhase>.broadcast(sync: true);
  @override
  Stream<VoicePlaybackPhase> get playbackStates => _events.stream;
  StreamSubscription<PlayerState>? _states;
  AudioPlayer? _player;
  PreparedVoiceSource? _source;
  int _generation = 0;
  bool _disposed = false;
  @override
  Future<void> load(Uint8List wav) async {
    if (_disposed) return;
    final generation = ++_generation;
    final player = _player = AudioPlayer();
    _states = player.onPlayerStateChanged.listen(
      (state) {
        if (_disposed || generation != _generation) return;
        final phase = switch (state) {
          PlayerState.playing => VoicePlaybackPhase.playing,
          PlayerState.paused => VoicePlaybackPhase.paused,
          PlayerState.completed => VoicePlaybackPhase.completed,
          _ => VoicePlaybackPhase.stopped,
        };
        _events.add(phase);
      },
      onError: (Object _) {
        if (!_disposed && generation == _generation) {
          _events.add(VoicePlaybackPhase.failed);
        }
      },
    );
    await player.setReleaseMode(ReleaseMode.release);
    if (_disposed || generation != _generation) return;
    final source = await prepareVoiceSource(wav);
    if (_disposed || generation != _generation) {
      await source.clear();
      return;
    }
    _source = source;
    await player.setSource(source.source);
  }

  @override
  Future<void> resume() async {
    if (!_disposed) await _player?.resume();
  }

  @override
  Future<void> stop() async {
    final generation = ++_generation;
    final source = _source;
    _source = null;
    final player = _player;
    _player = null;
    final states = _states;
    _states = null;
    await states?.cancel();
    if (generation == _generation && !_events.isClosed) {
      _events.add(VoicePlaybackPhase.stopped);
    }
    try {
      await player?.stop();
    } finally {
      await player?.dispose();
      await source?.clear();
    }
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    try {
      await stop();
    } finally {
      final player = _player;
      _player = null;
      await player?.dispose();
      await _events.close();
    }
  }
}

/// Loading is not playback. Re-check cancellation before issuing resume.
class GenerationVoicePlayer
    implements CreatureVoicePlayer, ObservableVoicePlayback {
  @override
  Stream<VoicePlaybackPhase> get playbackStates =>
      _backend is ObservableVoicePlayback
      ? (_backend as ObservableVoicePlayback).playbackStates
      : const Stream<VoicePlaybackPhase>.empty();
  GenerationVoicePlayer({VoicePlaybackBackend? backend})
    : _backend = backend ?? AudioplayersVoiceBackend();
  final VoicePlaybackBackend _backend;
  int _generation = 0;
  bool _disposed = false;
  @override
  Future<void> play(Uint8List wav) async {
    if (_disposed) return;
    final generation = ++_generation;
    await _backend.stop();
    if (_disposed || generation != _generation) return;
    try {
      await _backend.load(wav);
      if (_disposed || generation != _generation) return;
      await _backend.resume();
      if (_disposed || generation != _generation) await _backend.stop();
    } catch (_) {
      if (!_disposed && generation == _generation) await _backend.stop();
      rethrow;
    }
  }

  @override
  Future<void> stop() async {
    _generation++;
    await _backend.stop();
  }

  @override
  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    try {
      await _backend.stop();
    } finally {
      await _backend.dispose();
    }
  }
}

/// The service returns audio for an already-bound event, never arbitrary text.
Uint8List? validatedCreatureVoice(dynamic raw, Map event, Map context) {
  const keys = {
    'schema',
    'eventId',
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
      raw['schema'] != 'creature-voice.v1' ||
      raw['eventId'] != event['eventId'] ||
      raw['context'] is! Map ||
      (raw['context'] as Map).length != 2 ||
      raw['context']['creatureId'] != context['creatureId'] ||
      raw['context']['sceneRevision'] is! int ||
      raw['context']['sceneRevision'] != context['sceneRevision'] ||
      raw['mimeType'] != 'audio/wav' ||
      raw['engine'] != 'sherpa-onnx' ||
      raw['realProcessing'] != true ||
      raw['model'] is! String ||
      (raw['model'] as String).isEmpty ||
      (raw['model'] as String).length > 200 ||
      raw['base64'] is! String ||
      (raw['base64'] as String).length > 2796204) {
    return null;
  }
  try {
    final bytes = base64Decode(raw['base64']);
    if (bytes.length < 44 ||
        bytes.length > 2 * 1024 * 1024 ||
        ascii.decode(bytes.sublist(0, 4)) != 'RIFF' ||
        ascii.decode(bytes.sublist(8, 12)) != 'WAVE') {
      return null;
    }
    final data = ByteData.sublistView(bytes);
    if (data.getUint32(4, Endian.little) + 8 != bytes.length) return null;
    return bytes;
  } catch (_) {
    return null;
  }
}
