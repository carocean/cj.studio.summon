import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:summon_app/creature_voice.dart';
import 'package:summon_app/perception_capture.dart';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/creature_sense.dart';

import 'perception_test.dart' show FakeCapture;

Map<String, dynamic> authorizedSenseState({
  String creature = 'companion',
  int revision = 3,
  int generation = 1,
}) => {
  'mode': 'deterministic-synthetic',
  'activeCreatureId': creature,
  'context': {'creatureId': creature, 'sceneRevision': revision},
  'creatures': [
    {
      'id': creature,
      'name': '小伴',
      'personality': '测试',
      'body': 'sprout',
      'tone': 'playful',
      'kind': 'companion',
      'generation': generation,
      'senses': {'hearing': true, 'vision': true},
    },
  ],
};

class FakeVoicePlayer implements CreatureVoicePlayer {
  int plays = 0, stops = 0, disposals = 0;
  bool fail = false;
  @override
  Future<void> play(Uint8List wav) async {
    plays++;
    if (fail) throw StateError('playback_unavailable');
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

class SenseBackend {
  final calls = <String>[];
  String creature = 'companion', responseCreature = 'companion';
  bool available = true, omitReply = false, voiceAvailable = false;
  Map<String, dynamic> voiceOverrides = {};
  Completer<http.Response>? voiceHold;
  Map<String, dynamic> replyOverrides = {};
  Map<String, dynamic>? creatureProposal;
  Map<String, dynamic>? confirmedBody;
  int revision = 3, responseRevision = 3;
  String? candidate = 'work-context', failure;
  Completer<http.Response>? hold;
  Completer<http.Response>? confirmHold;
  http.Response reply(Object data, [int status = 200]) => http.Response(
    jsonEncode(data),
    status,
    headers: {'content-type': 'application/json; charset=utf-8'},
  );
  late final client = MockClient((request) async {
    calls.add(request.url.path);
    expect(request.url.host, '127.0.0.1');
    expect(request.url.port, 8091);
    if (request.url.path.endsWith('/state')) {
      return reply(
        authorizedSenseState(creature: creature, revision: revision),
      );
    }
    if (request.url.path.endsWith('sense-capabilities')) {
      return reply({
        'context': {'creatureId': creature, 'sceneRevision': revision},
        'capabilities': {
          'hearing': {'available': available},
          'vision': {'available': available},
        },
      });
    }
    expect(request.headers['X-Summon-Lab'], 'synthetic');
    final body = jsonDecode(request.body);
    expect(body['context'], {
      'creatureId': creature,
      'sceneRevision': revision,
    });
    if (failure != null) return reply({'error': failure}, 409);
    if (request.url.path.endsWith('/speak')) {
      expect(body.keys.toSet(), {'eventId', 'context'});
      expect(body['eventId'], 'e1');
      if (voiceHold != null) return voiceHold!.future;
      return reply({
        'schema': 'creature-voice.v1',
        'eventId': 'e1',
        'context': {
          'creatureId': responseCreature,
          'sceneRevision': responseRevision,
        },
        'mimeType': 'audio/wav',
        'base64': base64Encode(pcm16Wav(Uint8List(3200))),
        'engine': 'sherpa-onnx',
        'model': 'fixture-tts',
        'realProcessing': true,
        ...voiceOverrides,
      });
    }

    if (request.url.path.endsWith('sense-confirm')) {
      confirmedBody = Map<String, dynamic>.from(body);
      expect(body['eventId'], 'e1');
      expect(body['expectedCandidate'], candidate);
      expect(body['confirmation'], 'apply-scene-proposal');
      if (confirmHold != null) return confirmHold!.future;
      return reply({
        'replayed': false,
        'state': {'mode': 'deterministic-synthetic', 'creatures': []},
      });
    }
    expect(body['media']['base64'], isNotEmpty);
    if (hold != null) return hold!.future;
    return reply({
      'event': {
        'eventId': 'e1',
        'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
        'frame': {
          'creatureId': responseCreature,
          'sceneRevision': responseRevision,
        },
        'modality': body['modality'],
        'status': candidate == null ? 'observation' : 'awaiting_confirmation',
        'metadata': {
          'candidate': candidate,
          'creatureGeneration': 1,
          if (creatureProposal != null) 'creatureProposal': creatureProposal,
        },
      },
      'result': {
        'text': '测试识别内容',
        'engine': 'widget-fixture',
        'model': 'fixture',
        'realProcessing': true,
      },
      if (!omitReply)
        'companionReply': {
          'schema': 'creature-reply.v1',
          'creatureId': responseCreature,
          'sceneRevision': responseRevision,
          'eventId': 'e1',
          'source': 'deterministic-local',
          'llmUsed': false,
          'text': '我听到了。这是本地规则回应，动作仍待你确认。',
          'suggestedScene': candidate,
          ...replyOverrides,
        },
      'voiceAvailable': voiceAvailable,
      'llmUsed': false,
    });
  });
}

Future<void> tap(WidgetTester t, String key) async {
  final f = find.byKey(Key(key));
  await t.ensureVisible(f);
  await t.tap(f);
  await t.pumpAndSettle();
}

Future<void> mount(
  WidgetTester t,
  SenseBackend b,
  FakeCapture capture, {
  String modality = 'hearing',
  CreatureVoicePlayer? voicePlayer,
  String creatureId = 'companion',
  String creatureName = '小伴',
}) async {
  await t.pumpWidget(
    MaterialApp(
      home: CreatureSenseSheet(
        creatureId: creatureId,
        creatureName: creatureName,
        modality: modality,
        client: b.client,
        capture: capture,
        voicePlayer: voicePlayer,
      ),
    ),
  );
  await t.pumpAndSettle();
}

Future<void> capture(WidgetTester t) async {
  await tap(t, 'bound-capture');
  await tap(t, 'bound-capture');
}

void main() {
  testWidgets(
    'hearing stays creature bound; media upload and exact candidate each need separate confirmation',
    (t) async {
      final b = SenseBackend(), c = FakeCapture();
      await mount(t, b, c);
      expect(find.text('当前绑定：小伴（companion）'), findsOneWidget);
      await capture(t);
      expect(c.starts, 1);
      expect(b.calls.where((p) => p.endsWith('/sense')), isEmpty);
      await tap(t, 'bound-send');
      expect(find.byKey(const Key('bound-proposal')), findsOneWidget);
      expect(find.byKey(const Key('bound-creature-reply')), findsOneWidget);
      expect(find.text('小伴的回应 · 本地规则回应，非大模型'), findsOneWidget);
      expect(b.calls.where((p) => p.endsWith('sense-confirm')), isEmpty);
      await tap(t, 'bound-confirm');
      expect(find.byKey(const Key('bound-applied')), findsOneWidget);
      expect(b.calls.where((p) => p.endsWith('sense-confirm')).length, 1);
    },
  );
  testWidgets(
    'OCR never offers scene action even if response contains candidate',
    (t) async {
      final b = SenseBackend();
      await mount(t, b, FakeCapture(), modality: 'vision');
      await tap(t, 'bound-capture');
      await tap(t, 'bound-send');
      expect(find.byKey(const Key('bound-observation')), findsOneWidget);
      expect(find.byKey(const Key('bound-confirm')), findsNothing);
    },
  );
  testWidgets('unavailable processor and wrong creature prevent capture', (
    t,
  ) async {
    final b = SenseBackend()..available = false;
    final c = FakeCapture();
    await mount(t, b, c);
    expect(
      t.widget<FilledButton>(find.byKey(const Key('bound-capture'))).onPressed,
      isNull,
    );
    expect(c.starts, 0);
    await t.pumpWidget(const SizedBox());
    b.available = true;
    b.creature = 'work';
    await mount(t, b, c);
    expect(find.textContaining('sensory_context_changed'), findsOneWidget);
    expect(c.starts, 0);
  });
  testWidgets('OS permission refusal never uploads or produces result', (
    t,
  ) async {
    final b = SenseBackend(), c = FakeCapture()..denied = true;
    await mount(t, b, c);
    await tap(t, 'bound-capture');
    expect(find.byKey(const Key('bound-error')), findsOneWidget);
    expect(find.byKey(const Key('bound-send')), findsNothing);
    expect(b.calls.length, 1);
  });
  for (final failure in [
    'sensory_event_expired',
    'sensory_context_changed',
    'service_not_authorized',
    'authorization_changed',
    'sensory_candidate_unavailable',
  ]) {
    testWidgets(
      'confirmation rejects $failure without retry or context action',
      (t) async {
        final b = SenseBackend();
        await mount(t, b, FakeCapture());
        await capture(t);
        await tap(t, 'bound-send');
        b.failure = failure;
        await tap(t, 'bound-confirm');
        expect(find.textContaining(failure), findsOneWidget);
        expect(find.byKey(const Key('bound-confirm')), findsNothing);
        expect(b.calls.where((p) => p.endsWith('sense-confirm')).length, 1);
      },
    );
  }
  testWidgets('response revision mismatch cannot expose candidate', (t) async {
    final b = SenseBackend()..responseRevision = 4;
    await mount(t, b, FakeCapture());
    await capture(t);
    await tap(t, 'bound-send');
    expect(find.textContaining('sensory_response_mismatch'), findsOneWidget);
    expect(find.byKey(const Key('bound-confirm')), findsNothing);
  });
  testWidgets(
    'background stops recording, discards media, locks stale context',
    (t) async {
      final b = SenseBackend(), c = FakeCapture();
      await mount(t, b, c);
      await tap(t, 'bound-capture');
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await t.pumpAndSettle();
      expect(c.cancels, greaterThan(0));
      expect(find.byKey(const Key('bound-send')), findsNothing);
      expect(b.calls.length, 1);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      expect(c.starts, 1);
    },
  );
  testWidgets(
    'closed sheet disposes capture and ignores late processing response',
    (t) async {
      final b = SenseBackend()..hold = Completer<http.Response>();
      final c = FakeCapture();
      await mount(t, b, c);
      await capture(t);
      await t.ensureVisible(find.byKey(const Key('bound-send')));
      await t.tap(find.byKey(const Key('bound-send')));
      await t.pump();
      await t.pumpWidget(const SizedBox());
      expect(c.cancels, greaterThan(0));
      b.hold!.complete(b.reply({'event': {}, 'result': {}}));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(b.calls.where((p) => p.endsWith('sense-confirm')), isEmpty);
    },
  );
  for (final attack in <String, Map<String, dynamic>>{
    'wrong-creature': {'creatureId': 'work'},
    'wrong-revision': {'sceneRevision': 7},
    'wrong-event': {'eventId': 'other'},
    'wrong-candidate': {'suggestedScene': 'account-request'},
    'wrong-source': {'source': 'remote'},
    'wrong-schema': {'schema': 'unknown'},
    'unexpected-action': {
      'action': {'type': 'submit'},
    },
    'llm': {'llmUsed': true},
    'too-long': {'text': 'x' * 601},
    'wrong-type': {'text': 4},
  }.entries) {
    testWidgets(
      'invalid creature reply is hidden and cannot confirm: ${attack.key}',
      (t) async {
        final b = SenseBackend()..replyOverrides = attack.value;
        await mount(t, b, FakeCapture());
        await capture(t);
        await tap(t, 'bound-send');
        expect(find.byKey(const Key('bound-observation')), findsOneWidget);
        expect(find.byKey(const Key('bound-creature-reply')), findsNothing);
        expect(find.byKey(const Key('bound-confirm')), findsNothing);
        expect(find.byKey(const Key('bound-reply-rejected')), findsOneWidget);
      },
    );
  }
  testWidgets('missing reply cannot confirm; observation is still visible', (
    t,
  ) async {
    final b = SenseBackend()..omitReply = true;
    await mount(t, b, FakeCapture());
    await capture(t);
    await tap(t, 'bound-send');
    expect(find.byKey(const Key('bound-observation')), findsOneWidget);
    expect(find.byKey(const Key('bound-creature-reply')), findsNothing);
    expect(find.byKey(const Key('bound-confirm')), findsNothing);
  });
  testWidgets(
    'vision receives local observation reply with no suggested action',
    (t) async {
      final b = SenseBackend()..candidate = null;
      await mount(t, b, FakeCapture(), modality: 'vision');
      await tap(t, 'bound-capture');
      await tap(t, 'bound-send');
      expect(find.byKey(const Key('bound-creature-reply')), findsOneWidget);
      expect(find.byKey(const Key('bound-confirm')), findsNothing);
      expect(find.byType(TextField), findsNothing);
    },
  );
  test(
    'every companionReply field is required including nullable suggestedScene',
    () {
      final event = {
        'eventId': 'e1',
        'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
        'frame': {'creatureId': 'companion', 'sceneRevision': 3},
        'metadata': {'candidate': null},
        'modality': 'hearing',
        'status': 'observation',
      };
      final reply = {
        'schema': 'creature-reply.v1',
        'creatureId': 'companion',
        'sceneRevision': 3,
        'eventId': 'e1',
        'source': 'deterministic-local',
        'llmUsed': false,
        'text': '本地回应',
        'suggestedScene': null,
      };
      expect(validatedCreatureReply(reply, event, 'hearing'), isNotNull);
      for (final key in reply.keys) {
        final missing = Map<String, dynamic>.of(reply)..remove(key);
        expect(
          validatedCreatureReply(missing, event, 'hearing'),
          isNull,
          reason: key,
        );
      }
    },
  );
  testWidgets(
    'voice requires explicit click, plays only bound response, stops on next capture',
    (t) async {
      final b = SenseBackend()..voiceAvailable = true;
      final player = FakeVoicePlayer();
      await mount(t, b, FakeCapture(), voicePlayer: player);
      await capture(t);
      await tap(t, 'bound-send');
      expect(player.plays, 0);
      expect(b.calls.where((p) => p.endsWith('/speak')), isEmpty);
      await tap(t, 'bound-speak');
      expect(player.plays, 1);
      expect(find.byKey(const Key('bound-stop-voice')), findsOneWidget);
      final stops = player.stops;
      await tap(t, 'bound-capture');
      expect(player.stops, greaterThan(stops));
      await t.pumpWidget(const SizedBox());
      expect(player.disposals, 1);
    },
  );
  for (final attack in <String, Map<String, dynamic>>{
    'other-event': {'eventId': 'e2'},
    'other-creature': {
      'context': {'creatureId': 'work', 'sceneRevision': 3},
    },
    'other-revision': {
      'context': {'creatureId': 'companion', 'sceneRevision': 4},
    },
    'bad-base64': {'base64': '!invalid'},
    'oversize': {'base64': 'a' * 2796205},
    'not-wav': {'mimeType': 'audio/mp3'},
  }.entries) {
    testWidgets('invalid voice never plays: ${attack.key}', (t) async {
      final b = SenseBackend()
        ..voiceAvailable = true
        ..voiceOverrides = attack.value;
      final p = FakeVoicePlayer();
      await mount(t, b, FakeCapture(), voicePlayer: p);
      await capture(t);
      await tap(t, 'bound-send');
      await tap(t, 'bound-speak');
      expect(p.plays, 0);
      expect(find.textContaining('invalid_creature_voice'), findsOneWidget);
      expect(find.byKey(const Key('bound-speak')), findsNothing);
    });
  }
  testWidgets(
    'late voice after background is ignored and never automatically resumes',
    (t) async {
      final b = SenseBackend()
        ..voiceAvailable = true
        ..voiceHold = Completer<http.Response>();
      final p = FakeVoicePlayer();
      await mount(t, b, FakeCapture(), voicePlayer: p);
      await capture(t);
      await tap(t, 'bound-send');
      await t.ensureVisible(find.byKey(const Key('bound-speak')));
      await t.tap(find.byKey(const Key('bound-speak')));
      await t.pump();
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await t.pump();
      b.voiceHold!.complete(
        b.reply({'malformed': 'ignored after cancellation'}),
      );
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      expect(p.plays, 0);
      expect(p.stops, greaterThan(0));
    },
  );
  testWidgets('closed sheet ignores late synthesized voice', (t) async {
    final b = SenseBackend()
      ..voiceAvailable = true
      ..voiceHold = Completer<http.Response>();
    final p = FakeVoicePlayer();
    await mount(t, b, FakeCapture(), voicePlayer: p);
    await capture(t);
    await tap(t, 'bound-send');
    await t.ensureVisible(find.byKey(const Key('bound-speak')));
    await t.tap(find.byKey(const Key('bound-speak')));
    await t.pump();
    await t.pumpWidget(const SizedBox());
    b.voiceHold!.complete(b.reply({'ignored': true}));
    await t.pumpAndSettle();
    expect(p.plays, 0);
    expect(p.disposals, 1);
    expect(t.takeException(), isNull);
  });
  testWidgets('playback failure is reported without automatic retry', (
    t,
  ) async {
    final b = SenseBackend()..voiceAvailable = true;
    final p = FakeVoicePlayer()..fail = true;
    await mount(t, b, FakeCapture(), voicePlayer: p);
    await capture(t);
    await tap(t, 'bound-send');
    await tap(t, 'bound-speak');
    expect(p.plays, 1);
    expect(find.textContaining('播放未确认'), findsOneWidget);
    expect(find.byKey(const Key('bound-speak')), findsNothing);
  });
  testWidgets(
    'expired voice event stops and requires fresh capture rather than retry',
    (t) async {
      final b = SenseBackend()..voiceAvailable = true;
      final p = FakeVoicePlayer();
      await mount(t, b, FakeCapture(), voicePlayer: p);
      await capture(t);
      await tap(t, 'bound-send');
      b.failure = 'sensory_event_expired';
      await tap(t, 'bound-speak');
      expect(p.plays, 0);
      expect(find.textContaining('sensory_event_expired'), findsOneWidget);
      expect(find.byKey(const Key('bound-speak')), findsNothing);
      expect(find.byKey(const Key('bound-confirm')), findsNothing);
      expect(b.calls.where((p) => p.endsWith('/speak')).length, 1);
    },
  );
  testWidgets('stop during synthesis suppresses late audio', (t) async {
    final b = SenseBackend()
      ..voiceAvailable = true
      ..voiceHold = Completer<http.Response>();
    final p = FakeVoicePlayer();
    await mount(t, b, FakeCapture(), voicePlayer: p);
    await capture(t);
    await tap(t, 'bound-send');
    await t.ensureVisible(find.byKey(const Key('bound-speak')));
    await t.tap(find.byKey(const Key('bound-speak')));
    await t.pump();
    await t.ensureVisible(find.byKey(const Key('bound-stop-voice')));
    await t.tap(find.byKey(const Key('bound-stop-voice')));
    await t.pump();
    b.voiceHold!.complete(b.reply({'ignored': true}));
    await t.pumpAndSettle();
    expect(p.plays, 0);
  });
  testWidgets(
    'third registered creature remains bound through hearing reply and voice',
    (t) async {
      final b = SenseBackend()
        ..creature = 'moss'
        ..responseCreature = 'moss'
        ..voiceAvailable = true;
      final player = FakeVoicePlayer();
      await mount(
        t,
        b,
        FakeCapture(),
        voicePlayer: player,
        creatureId: 'moss',
        creatureName: '苔苔',
      );
      expect(find.text('当前绑定：苔苔（moss）'), findsOneWidget);
      await capture(t);
      await tap(t, 'bound-send');
      expect(find.text('苔苔的回应 · 本地规则回应，非大模型'), findsOneWidget);
      await tap(t, 'bound-speak');
      expect(player.plays, 1);
    },
  );
}
