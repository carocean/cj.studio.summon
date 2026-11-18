import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/route_voice.dart';
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/perception_capture.dart';

import 'creature_sense_test.dart' show FakeVoicePlayer;
import 'creature_market_test.dart' as market;

Map<String, dynamic> state() => market.state()
  ..['context'] = {'creatureId': 'maps-one', 'sceneRevision': 4}
  ..['voiceAvailable'] = true;
Map<String, dynamic> audio() => {
  'schema': 'route-voice.v1',
  'receiptId': 'r1',
  'context': {'creatureId': 'maps-one', 'sceneRevision': 4},
  'mimeType': 'audio/wav',
  'base64': base64Encode(pcm16Wav(Uint8List(3200))),
  'engine': 'sherpa-onnx',
  'model': 'test',
  'realProcessing': true,
};
void main() {
  test('receipt voice exact envelope and audio limits', () {
    final a = audio();
    expect(validatedRouteVoice(a, 'r1', state()['context']), isNotNull);
    a['receiptId'] = 'other';
    expect(validatedRouteVoice(a, 'r1', state()['context']), isNull);
    a['receiptId'] = 'r1';
    a['text'] = 'injected';
    expect(validatedRouteVoice(a, 'r1', state()['context']), isNull);
  });
  testWidgets(
    'explicit receipt playback needs no hearing grant; dispose stops',
    (t) async {
      final player = FakeVoicePlayer();
      var calls = 0;
      final api = SceneExperimentApi(
        MockClient((req) async {
          calls++;
          expect(jsonDecode(req.body), {
            'receiptId': 'r1',
            'context': state()['context'],
          });
          return http.Response(jsonEncode(audio()), 200);
        }),
      );
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: RouteVoiceControl(state: state(), api: api, player: player),
          ),
        ),
      );
      expect(calls, 0);
      await t.tap(find.byKey(const Key('route-speak')));
      await t.pumpAndSettle();
      expect(calls, 1);
      expect(player.plays, 1);
      await t.pumpWidget(const MaterialApp(home: Scaffold()));
      expect(player.disposals, 1);
    },
  );
  testWidgets('background invalidates late audio; no automatic resume', (
    t,
  ) async {
    final player = FakeVoicePlayer(), hold = Completer<http.Response>();
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RouteVoiceControl(
            state: state(),
            api: SceneExperimentApi(MockClient((_) => hold.future)),
            player: player,
          ),
        ),
      ),
    );
    await t.tap(find.byKey(const Key('route-speak')));
    await t.pump();
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    hold.complete(http.Response(jsonEncode(audio()), 200));
    await t.pumpAndSettle();
    expect(player.plays, 0);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await t.pump();
    expect(player.plays, 0);
  });
  testWidgets('receipt/context change invalidates delayed audio', (t) async {
    final player = FakeVoicePlayer(), hold = Completer<http.Response>();
    final api = SceneExperimentApi(MockClient((_) => hold.future));
    Future<void> render(Map<String, dynamic> s) => t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RouteVoiceControl(state: s, api: api, player: player),
        ),
      ),
    );
    await render(state());
    await t.tap(find.byKey(const Key('route-speak')));
    await t.pump();
    final changed = state();
    changed['context']['sceneRevision'] = 5;
    await render(changed);
    hold.complete(http.Response(jsonEncode(audio()), 200));
    await t.pumpAndSettle();
    expect(player.plays, 0);
  });
}
