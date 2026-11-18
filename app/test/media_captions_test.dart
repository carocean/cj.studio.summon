import 'dart:convert';
import 'dart:async';
import 'dart:typed_data';

import 'package:summon_app/creature_sense.dart';
import 'package:summon_app/creature_voice.dart';

import 'creature_sense_test.dart' as sense;
import 'perception_test.dart' show FakeCapture;

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/media_captions.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/standin_avatar.dart';

import 'creature_home_minimal_test.dart' as home;

Map<String, dynamic> state({
  int revision = 1,
  int generation = 1,
  bool hearing = true,
}) {
  final s = home.state();
  s['context'] = {'creatureId': 'companion', 'sceneRevision': revision};
  final c = (s['creatures'] as List).firstWhere((c) => c['id'] == 'companion');
  c['generation'] = generation;
  c['senses'] = {'hearing': hearing, 'vision': true};
  return s;
}

Map<String, dynamic> response({
  String modality = 'hearing',
  int generation = 1,
  int revision = 1,
}) => {
  'event': {
    'eventId': 'sense-one',
    'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
    'frame': {'creatureId': 'companion', 'sceneRevision': revision},
    'modality': modality,
    'status': 'observation',
    'metadata': {'creatureGeneration': generation, 'realProcessing': true},
  },
  'result': {'text': '你好 <b>原文</b>', 'realProcessing': true},
};
Map<String, dynamic> reply() => {
  'eventId': 'sense-one',
  'creatureId': 'companion',
  'sceneRevision': 1,
  'text': '你好，我在。',
};

class ObservedPlayer extends sense.FakeVoicePlayer
    implements ObservableVoicePlayback {
  Completer<void>? stopGate;
  @override
  Future<void> stop() async {
    await super.stop();
    await stopGate?.future;
  }

  final events = StreamController<VoicePlaybackPhase>.broadcast(sync: true);
  @override
  Stream<VoicePlaybackPhase> get playbackStates => events.stream;
  @override
  Future<void> play(Uint8List wav) async {
    await super.play(wav);
  }
}

void main() {
  test('starts blank and OFF authorization cannot begin; real ASR not generated reply supplies user text', () {
    final c = BoundMediaCaptions();
    addTearDown(c.dispose);
    expect(c.visible, false);
    expect(c.begin(state()['context'], 'hearing'), null);
    c.bind(state(hearing: false));
    expect(c.begin(state()['context'], 'hearing'), null);
    c.bind(state());
    final r = c.begin(state()['context'], 'hearing');
    expect(c.userStatus, '正在识别语音…');
    expect(c.userText, null);
    expect(c.accept(r, response(), reply()), true);
    expect(c.userText, '你好 <b>原文</b>');
    expect(c.creatureText, null);
    expect(c.speaking, false);
  });
  test('vision is never a user speech subtitle and cross-modality response is refused', () {
    final c = BoundMediaCaptions()..bind(state());
    addTearDown(c.dispose);
    var r = c.begin(state()['context'], 'vision');
    expect(c.accept(r, response(modality: 'vision'), reply()), true);
    expect(c.userText, null);
    r = c.begin(state()['context'], 'hearing');
    expect(c.accept(r, response(modality: 'vision'), reply()), false);
    expect(c.userText, null);
  });
  test('wrong generation/context/non-real result is rejected', () {
    for (final raw in [
      response(generation: 2),
      response(revision: 2),
      {
        ...response(),
        'result': {'text': 'fake', 'realProcessing': false},
      },
    ]) {
      final c = BoundMediaCaptions()..bind(state());
      final r = c.begin(state()['context'], 'hearing');
      expect(c.accept(r, raw, reply()), false);
      expect(c.userText, null);
      expect(c.userStatus, '识别失败，未确认内容');
      c.dispose();
    }
  });
  test('new round, revocation and scene change fence old replies/playback', () {
    final c = BoundMediaCaptions()..bind(state());
    addTearDown(c.dispose);
    final r = c.begin(state()['context'], 'hearing');
    c.accept(r, response(), reply());
    c.begin(state()['context'], 'hearing');
    expect(c.accept(r, response(), reply()), false);
    c.voice(r, 'sense-one', 'playing');
    expect(c.speaking, false);
    c.bind(state(generation: 2, hearing: false));
    expect(c.visible, false);
    c.bind(state(revision: 2));
    expect(c.begin(state()['context'], 'hearing'), null);
  });
  test('only bound actual playing displays reply; completed does not claim user heard it', () {
    final c = BoundMediaCaptions()..bind(state());
    addTearDown(c.dispose);
    final r = c.begin(state()['context'], 'hearing');
    c.accept(r, response(), reply());
    c.voice(r, 'sense-other', 'playing');
    expect(c.creatureText, null);
    c.voice(r, 'sense-one', 'preparing');
    expect(c.creatureText, null);
    expect(c.speaking, false);
    c.voice(r, 'sense-one', 'playing');
    expect(c.creatureText, '你好，我在。');
    expect(c.speaking, true);
    for (final phase in ['paused', 'completed', 'stopped', 'failed']) {
      c.voice(r, 'sense-one', phase);
      expect(c.speaking, false);
    }
    c.voice(r, 'sense-one', 'preparing');
    expect(c.creatureText, null);
  });
  testWidgets(
    'captions expire without history and late callbacks cannot resurrect',
    (t) async {
      final c = BoundMediaCaptions(lifetime: const Duration(seconds: 2))
        ..bind(state());
      final r = c.begin(state()['context'], 'hearing');
      c.accept(r, response(), reply());
      await t.pump(const Duration(seconds: 3));
      expect(c.visible, false);
      c.voice(r, 'sense-one', 'playing');
      expect(c.visible, false);
      c.dispose();
    },
  );
  testWidgets(
    'real Home shows current plain subtitles and clears on background, never adds input',
    (t) async {
      final controller = CreatureHomeController();
      final client = MockClient(
        (_) async => http.Response(
          jsonEncode(state()),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        ),
      );
      await t.pumpWidget(
        MaterialApp(
          home: CreatureHome(controller: controller, client: client),
        ),
      );
      expect(find.byType(Text), findsNothing);
      await controller.refreshMediaContext();
      final c = controller.mediaCaptions!;
      final r = c.begin(state()['context'], 'hearing');
      c.accept(r, response(), reply());
      await t.pump();
      expect(find.text('你好 <b>原文</b>'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      c.voice(r, 'sense-one', 'playing');
      await t.pump();
      expect(
        t.widget<StandInAvatar>(find.byType(StandInAvatar)).speaking,
        true,
      );
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await t.pump();
      expect(find.byType(Text), findsNothing);
      expect(c.begin(state()['context'], 'hearing'), isNull);
      c.voice(r, 'sense-one', 'playing');
      await t.pump();
      expect(find.byType(Text), findsNothing);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpWidget(const SizedBox());
      client.close();
    },
  );
  test('failure after playing clears both old speech and mouth state', () {
    final c = BoundMediaCaptions()..bind(state());
    addTearDown(c.dispose);
    final r = c.begin(state()['context'], 'hearing');
    c.accept(r, response(), reply());
    c.voice(r, 'sense-one', 'playing');
    expect(c.speaking, true);
    c.fail(r);
    expect(c.accept(r, response(), reply()), false);
    expect(c.speaking, false);
    expect(c.creatureText, null);
    expect(c.creatureStatus, null);
    c.voice(r, 'sense-one', 'playing');
    expect(c.speaking, false);
  });
  testWidgets('long plain subtitles are bounded to three lines with ellipsis', (
    t,
  ) async {
    final c = BoundMediaCaptions()..bind(state());
    final r = c.begin(state()['context'], 'hearing');
    final raw = response();
    raw['result']['text'] = '长' * 12000;
    c.accept(r, raw, reply());
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(width: 300, child: MediaCaptionView(captions: c)),
        ),
      ),
    );
    final text = t.widget<Text>(find.byKey(const Key('media-user-caption')));
    expect(text.maxLines, 3);
    expect(text.overflow, TextOverflow.ellipsis);
    expect(t.takeException(), null);
    await t.pumpWidget(const SizedBox());
    c.dispose();
  });
  testWidgets(
    'HTTP sense-to-caption and validated audio need an observed playing state',
    (t) async {
      final backend = sense.SenseBackend()
        ..revision = 1
        ..responseRevision = 1
        ..candidate = null
        ..voiceAvailable = true;
      final captions = BoundMediaCaptions()..bind(state());
      final voice = ObservedPlayer();
      final client = MockClient((request) async {
        if (request.url.path.endsWith('/state')) return home.response(state());
        final forwarded = http.Request(request.method, request.url)
          ..headers.addAll(request.headers)
          ..body = request.body;
        final result = await backend.client.send(forwarded);
        final raw = await http.Response.fromStream(result);
        if (!request.url.path.endsWith('/sense')) return raw;
        final json = jsonDecode(raw.body) as Map<String, dynamic>;
        json['event']['expiresAt'] =
            DateTime.now().millisecondsSinceEpoch + 60000;
        json['event']['metadata']['realProcessing'] = true;
        json['event']['metadata']['creatureGeneration'] = 1;
        return home.response(json);
      });
      await t.pumpWidget(
        MaterialApp(
          home: CreatureSenseSheet(
            creatureId: 'companion',
            creatureName: '小伴',
            modality: 'hearing',
            client: client,
            capture: FakeCapture(),
            voicePlayer: voice,
            captions: captions,
          ),
        ),
      );
      await t.pumpAndSettle();
      await sense.tap(t, 'bound-capture');
      await sense.tap(t, 'bound-capture');
      await sense.tap(t, 'bound-send');
      expect(captions.userText, '测试识别内容');
      expect(captions.creatureText, null);
      await sense.tap(t, 'bound-speak');
      expect(voice.plays, 1);
      expect(captions.creatureText, null);
      expect(captions.speaking, false);
      voice.events.add(VoicePlaybackPhase.playing);
      expect(captions.speaking, true);
      expect(captions.creatureText, contains('本地规则回应'));
      voice.events.add(VoicePlaybackPhase.completed);
      expect(captions.speaking, false);
      final text = captions.creatureText;
      await t.pumpWidget(const SizedBox());
      await t.pump();
      voice.events.add(VoicePlaybackPhase.playing);
      expect(captions.speaking, false);
      expect(captions.creatureText, text);
      captions.dispose();
      await voice.events.close();
      client.close();
      backend.client.close();
    },
  );
  for (final enabled in [true, false]) {
    for (final invalid in [
      'revoked',
      'context',
      'generation',
      'unavailable',
      'caption-rejected',
    ]) {
      testWidgets(
        'post-sense authority $invalid locks sheet; captions=$enabled',
        (t) async {
          final backend = sense.SenseBackend()
            ..revision = 1
            ..responseRevision = 1
            ..voiceAvailable = true;
          final captions = enabled
              ? (BoundMediaCaptions()..bind(state()))
              : null;
          final voice = ObservedPlayer();
          final client = MockClient((request) async {
            if (request.url.path.endsWith('/state')) {
              if (invalid == 'unavailable') {
                return http.Response('{"error":"unavailable"}', 503);
              }
              return home.response(
                state(
                  hearing: invalid != 'revoked',
                  revision: invalid == 'context' ? 2 : 1,
                  generation: invalid == 'generation' ? 2 : 1,
                ),
              );
            }
            final forwarded = http.Request(request.method, request.url)
              ..headers.addAll(request.headers)
              ..body = request.body;
            final result = await http.Response.fromStream(
              await backend.client.send(forwarded),
            );
            if (!request.url.path.endsWith('/sense')) return result;
            final raw = jsonDecode(result.body);
            raw['event']['expiresAt'] =
                DateTime.now().millisecondsSinceEpoch + 60000;
            raw['event']['metadata']['realProcessing'] = true;
            raw['event']['metadata']['creatureGeneration'] = 1;
            if (invalid == 'caption-rejected') {
              // Reject expired evidence independently of optional captions.
              raw['event']['expiresAt'] = 0;
            }
            return home.response(raw);
          });
          await t.pumpWidget(
            MaterialApp(
              home: CreatureSenseSheet(
                creatureId: 'companion',
                creatureName: '小伴',
                modality: 'hearing',
                client: client,
                capture: FakeCapture(),
                voicePlayer: voice,
                captions: captions,
              ),
            ),
          );
          await t.pumpAndSettle();
          await sense.capture(t);
          final stops = voice.stops;
          if (invalid == 'unavailable') voice.stopGate = Completer<void>();
          await t.ensureVisible(find.byKey(const Key('bound-send')));
          await t.tap(find.byKey(const Key('bound-send')));
          for (var i = 0; i < 8; i++) {
            await t.pump(const Duration(milliseconds: 30));
          }
          expect(find.text('测试识别内容'), findsNothing);
          expect(find.byKey(const Key('bound-creature-reply')), findsNothing);
          expect(find.byKey(const Key('bound-speak')), findsNothing);
          expect(find.byKey(const Key('bound-confirm')), findsNothing);
          expect(find.byKey(const Key('bound-error')), findsOneWidget);
          expect(
            t
                .widget<FilledButton>(find.byKey(const Key('bound-capture')))
                .onPressed,
            null,
          );
          expect(voice.stops, greaterThan(stops));
          expect(captions?.userText, null);
          if (invalid == 'revoked') {
            expect(captions?.begin(state()['context'], 'hearing'), null);
          }
          voice.stopGate?.complete();
          await t.pumpWidget(const SizedBox());
          await t.pump();
          captions?.dispose();
          await voice.events.close();
          client.close();
          backend.client.close();
        },
      );
    }
  }
}
