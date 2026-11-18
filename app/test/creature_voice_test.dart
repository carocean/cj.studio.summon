import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:audioplayers/audioplayers.dart';
import 'package:summon_app/creature_voice.dart';
import 'package:summon_app/voice_source_io.dart';

class PlaybackBackend implements VoicePlaybackBackend {
  final loaded = Completer<void>();
  int resumes = 0, stops = 0, disposals = 0;
  @override
  Future<void> load(Uint8List data) => loaded.future;
  @override
  Future<void> resume() async {
    resumes++;
  }

  @override
  Future<void> stop() async {
    stops++;
  }

  @override
  Future<void> dispose() async {
    disposals++;
  }
}

void main() {
  test('stop while preparing audio suppresses later resume', () async {
    final b = PlaybackBackend();
    final p = GenerationVoicePlayer(backend: b);
    final pending = p.play(Uint8List(2));
    await Future<void>.delayed(Duration.zero);
    await p.stop();
    b.loaded.complete();
    await pending;
    expect(b.resumes, 0);
    await p.dispose();
  });
  test(
    'dispose while loading never resumes and future play is inert',
    () async {
      final b = PlaybackBackend();
      final p = GenerationVoicePlayer(backend: b);
      final pending = p.play(Uint8List(2));
      await Future<void>.delayed(Duration.zero);
      await p.dispose();
      b.loaded.complete();
      await pending;
      await p.play(Uint8List(2));
      expect(b.resumes, 0);
      expect(b.disposals, 1);
    },
  );
  test(
    'native voice source uses owned temporary file and deletes it',
    () async {
      final source = await prepareVoiceSource(Uint8List.fromList([1, 2, 3]));
      final path = (source.source as DeviceFileSource).path;
      expect(await File(path).readAsBytes(), [1, 2, 3]);
      if (Platform.isLinux) {
        final stat = await Process.run('stat', [
          '-c',
          '%a',
          source.directory.path,
        ]);
        expect(stat.exitCode, 0);
        expect((stat.stdout as String).trim(), '700');
      }
      await source.clear();
      expect(await File(path).exists(), isFalse);
    },
  );
  test('load failure stops backend and never resumes', () async {
    final b = PlaybackBackend();
    final p = GenerationVoicePlayer(backend: b);
    final pending = p.play(Uint8List(2));
    await Future<void>.delayed(Duration.zero);
    final check = expectLater(pending, throwsStateError);
    b.loaded.completeError(StateError('load failed'));
    await check;
    expect(b.resumes, 0);
    expect(b.stops, 2);
    await p.dispose();
  });
}
