import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';

class PreparedVoiceSource {
  PreparedVoiceSource(this.source, this.directory);
  final Source source;
  final Directory directory;
  Future<void> clear() async {
    if (await directory.exists()) await directory.delete(recursive: true);
  }
}

Future<PreparedVoiceSource> prepareVoiceSource(Uint8List wav) async {
  final directory = await Directory.systemTemp.createTemp('summon-voice-');
  try {
    final file = File('${directory.path}/reply.wav');
    await file.writeAsBytes(wav, flush: true);
    return PreparedVoiceSource(
      DeviceFileSource(file.path, mimeType: 'audio/wav'),
      directory,
    );
  } catch (_) {
    await directory.delete(recursive: true);
    rethrow;
  }
}
