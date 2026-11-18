import 'dart:async';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/creature_workbench.dart';

import 'scene_experiment_test.dart' show Lab;

import 'package:summon_app/spoken_creature.dart';
import 'package:summon_app/creature_sense.dart';

import 'creature_sense_test.dart' as sense;
import 'perception_test.dart' show FakeCapture;

Map<String, dynamic> proposal([String status = 'ready']) => {
  'schema': 'spoken-creature.v1',
  'status': status,
  'registryRevision': 7,
  'targetCreatureId': status == 'ready' ? 'pet-one' : null,
  'targetName': status == 'ready' ? '小花' : null,
};
Map<String, dynamic> event(
  dynamic p, {
  String modality = 'hearing',
  String? candidate = 'creature-request',
}) => {
  'eventId': 'e1',
  'frame': {'creatureId': 'companion', 'sceneRevision': 3},
  'modality': modality,
  'status': candidate == null ? 'observation' : 'awaiting_confirmation',
  'metadata': {
    'candidate': candidate,
    'creatureProposal': p,
    'creatureGeneration': 1,
  },
};
Map<String, dynamic> reply([String? candidate = 'creature-request']) => {
  'schema': 'creature-reply.v1',
  'creatureId': 'companion',
  'sceneRevision': 3,
  'eventId': 'e1',
  'source': 'deterministic-local',
  'llmUsed': false,
  'text': '可以切换，请另行确认。',
  'suggestedScene': candidate,
};
void main() {
  test('bounded creature target has exact schema, finite status, safe version and no borrowed route authority', () {
    final p = proposal();
    expect(validatedSpokenCreature(p, event(p), 'hearing'), p);
    for (final attack in [
      null,
      {...p, 'extra': 'permission'},
      {...p, 'registryRevision': 0},
      {...p, 'registryRevision': 7.0},
      {...p, 'registryRevision': 9007199254740992},
      {...p, 'targetCreatureId': '../other'},
      {...p, 'targetName': '\nwrong'},
      {...p, 'targetName': 'x' * 65},
      {...p, 'schema': 'other'},
      {...p, 'status': 'other'},
      {...p, 'targetCreatureId': null},
    ]) {
      expect(validatedSpokenCreature(attack, event(attack), 'hearing'), null);
      expect(validatedCreatureReply(reply(), event(attack), 'hearing'), null);
    }
    final e = event(p);
    (e['metadata'] as Map)['routeProposal'] = {'status': 'ready'};
    expect(validatedSpokenCreature(p, e, 'hearing'), null);
  });
  test('ambiguous or unavailable resolution cannot become a confirmed target, even through a friendly reply', () {
    for (final status in ['ambiguous', 'unavailable']) {
      final p = proposal(status), e = event(proposal(status), candidate: null);
      expect(validatedSpokenCreature(p, e, 'hearing'), p);
      expect(validatedCreatureReply(reply(null), e, 'hearing'), isNotNull);
      expect(validatedCreatureReply(reply(), e, 'hearing'), null);
      expect(
        validatedSpokenCreature(
          {...p, 'targetCreatureId': 'pet-one'},
          e,
          'hearing',
        ),
        null,
      );
    }
    final p = proposal();
    expect(
      validatedCreatureReply(reply(), event(p, modality: 'vision'), 'vision'),
      null,
    );
  });
  testWidgets(
    'ready name request names exact target and confirms entire bound proposal only after click',
    (t) async {
      final b = sense.SenseBackend()
        ..candidate = 'creature-request'
        ..creatureProposal = proposal();
      await sense.mount(t, b, FakeCapture());
      await sense.capture(t);
      await sense.tap(t, 'bound-send');
      expect(
        find.textContaining('切换到 小花（pet-one），不改变主生物或开启感官'),
        findsOneWidget,
      );
      expect(b.confirmedBody, null);
      await sense.tap(t, 'bound-confirm');
      expect(b.confirmedBody!['expectedCreatureProposal'], proposal());
      expect(b.confirmedBody!['expectedCandidate'], 'creature-request');
      expect(find.byKey(const Key('bound-applied')), findsOneWidget);
    },
  );
  for (final status in ['ambiguous', 'unavailable']) {
    testWidgets(
      '$status target is explained without guessing or confirmation',
      (t) async {
        final b = sense.SenseBackend()
          ..candidate = null
          ..creatureProposal = proposal(status);
        await sense.mount(t, b, FakeCapture());
        await sense.capture(t);
        await sense.tap(t, 'bound-send');
        expect(find.byKey(Key('bound-creature-$status')), findsOneWidget);
        expect(find.byKey(const Key('bound-confirm')), findsNothing);
        expect(b.confirmedBody, null);
      },
    );
  }
  testWidgets(
    'OCR containing a ready creature proposal is display-only and rejected',
    (t) async {
      final b = sense.SenseBackend()
        ..candidate = 'creature-request'
        ..creatureProposal = proposal();
      await sense.mount(t, b, FakeCapture(), modality: 'vision');
      await sense.tap(t, 'bound-capture');
      await sense.tap(t, 'bound-send');
      expect(find.byKey(const Key('bound-confirm')), findsNothing);
      expect(find.byKey(const Key('bound-reply-rejected')), findsOneWidget);
    },
  );
  testWidgets('forged target cannot generate a confirm control', (t) async {
    final b = sense.SenseBackend()
      ..candidate = 'creature-request'
      ..creatureProposal = {...proposal(), 'grantSenses': true};
    await sense.mount(t, b, FakeCapture());
    await sense.capture(t);
    await sense.tap(t, 'bound-send');
    expect(find.byKey(const Key('bound-confirm')), findsNothing);
    expect(find.byKey(const Key('bound-reply-rejected')), findsOneWidget);
  });
  testWidgets(
    'late ready creature proposal after leaving sheet never causes a switch',
    (t) async {
      final b = sense.SenseBackend()
        ..candidate = 'creature-request'
        ..creatureProposal = proposal()
        ..hold = Completer<http.Response>();
      await sense.mount(t, b, FakeCapture());
      await sense.capture(t);
      await t.ensureVisible(find.byKey(const Key('bound-send')));
      await t.tap(find.byKey(const Key('bound-send')));
      await t.pump();
      await t.pumpWidget(const SizedBox());
      b.hold!.complete(
        b.reply({
          'event': event(proposal()),
          'result': {'text': '切换到小花', 'realProcessing': true},
          'companionReply': reply(),
        }),
      );
      await t.pumpAndSettle();
      expect(t.takeException(), null);
      expect(b.confirmedBody, null);
    },
  );
  testWidgets(
    'confirmed name returns directly to CreatureWorkbench and reloads selected target',
    (t) async {
      final b = sense.SenseBackend()
        ..candidate = 'creature-request'
        ..creatureProposal = proposal();
      var reads = 0;
      final client = MockClient((r) async {
        if (r.url.path.endsWith('/state')) {
          reads++;
          return b.reply({
            ...Lab().state,
            'context': {'creatureId': 'companion', 'sceneRevision': 3},
            'activeCreatureId': b.confirmedBody == null
                ? 'companion'
                : 'pet-one',
            'creatures': [
              ...(Lab().state['creatures'] as List).map(
                (c) => {...c as Map, 'generation': 1},
              ),
              {
                'id': 'pet-one',
                'name': '小花',
                'kind': 'pet',
                'personality': '测试伙伴',
                'body': 'sprout',
                'tone': 'playful',
                'senses': {'hearing': false, 'vision': false},
                'generation': 0,
              },
            ],
          });
        }
        final forwarded = http.Request(r.method, r.url)
          ..headers.addAll(r.headers)
          ..body = r.body;
        return http.Response.fromStream(await b.client.send(forwarded));
      });
      await t.pumpWidget(
        MaterialApp(
          home: CreatureWorkbench(
            client: client,
            senseCaptureFactory: () => FakeCapture(),
          ),
        ),
      );
      Future<void> settleHome() async {
        for (var i = 0; i < 8; i++) {
          await t.pump(const Duration(milliseconds: 80));
        }
      }

      await settleHome();
      await t.ensureVisible(find.byKey(const Key('creature-hear')));
      await t.tap(find.byKey(const Key('creature-hear')));
      await settleHome();
      await sense.capture(t);
      await sense.tap(t, 'bound-send');
      await t.ensureVisible(find.byKey(const Key('bound-confirm')));
      await t.tap(find.byKey(const Key('bound-confirm')));
      await settleHome();
      expect(find.byType(CreatureSenseSheet), findsNothing);
      expect(find.text('小花'), findsOneWidget);
      expect(reads, 3);
    },
  );
  testWidgets('late confirmation cannot pop a newer route covering the sheet', (
    t,
  ) async {
    final b = sense.SenseBackend()
      ..candidate = 'creature-request'
      ..creatureProposal = proposal()
      ..confirmHold = Completer<http.Response>();
    final navigator = GlobalKey<NavigatorState>();
    await t.pumpWidget(
      MaterialApp(
        navigatorKey: navigator,
        home: const Scaffold(body: Text('home')),
      ),
    );
    navigator.currentState!.push(
      MaterialPageRoute<void>(
        builder: (_) => CreatureSenseSheet(
          creatureId: 'companion',
          creatureName: '小伴',
          modality: 'hearing',
          client: b.client,
          capture: FakeCapture(),
        ),
      ),
    );
    await t.pumpAndSettle();
    await sense.capture(t);
    await sense.tap(t, 'bound-send');
    await t.ensureVisible(find.byKey(const Key('bound-confirm')));
    await t.tap(find.byKey(const Key('bound-confirm')));
    await t.pump();
    navigator.currentState!.push(
      MaterialPageRoute<void>(
        builder: (_) => const Scaffold(body: Text('newer route')),
      ),
    );
    await t.pumpAndSettle();
    b.confirmHold!.complete(
      b.reply({
        'state': {'mode': 'deterministic-synthetic'},
        'replayed': false,
      }),
    );
    await t.pumpAndSettle();
    expect(find.text('newer route'), findsOneWidget);
    navigator.currentState!.pop();
    await t.pumpAndSettle();
    expect(find.byKey(const Key('bound-applied')), findsOneWidget);
  });
}
