import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';

class PreparedVoiceSource {
  PreparedVoiceSource(this.source);
  final Source source;
  Future<void> clear() async {}
}

Future<PreparedVoiceSource> prepareVoiceSource(Uint8List wav) async =>
    PreparedVoiceSource(BytesSource(wav, mimeType: 'audio/wav'));
