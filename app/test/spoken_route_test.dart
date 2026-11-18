import 'dart:convert';
import 'dart:async';

import 'perception_test.dart' show FakeCapture;

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/spoken_route.dart';
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/creature_sense.dart';

import 'creature_market_test.dart' as market;
import 'creature_sense_test.dart' show authorizedSenseState;

Map<String, dynamic> proposal() => {
  'schema': 'spoken-route-proposal.v1',
  'proposalId': 'sr-e1',
  'eventId': 'e1',
  'context': {'creatureId': 'companion', 'sceneRevision': 3},
  'requestId': 'speech-e1',
  'productId': 'demo.maps.v1',
  'providerId': 'demo-maps',
  'instanceId': 'maps-one',
  'serviceId': 'synthetic.route.v1',
  'serviceVersion': 1,
  'from': 'A',
  'to': 'C',
  'source': 'finite-spoken-route.v1',
  'status': 'ready',
  'reason': null,
  'subscriptionRevision': 2,
  'subscriptionGeneration': 1,
  'expiresAt': DateTime.now().millisecondsSinceEpoch + 30000,
};
Map<String, dynamic> event(Map p) => {
  'eventId': 'e1',
  'expiresAt': p['expiresAt'],
  'frame': p['context'],
  'modality': 'hearing',
  'status': p['status'] == 'ready'
      ? 'awaiting_route_confirmation'
      : 'observation',
  'metadata': {'candidate': null, 'routeProposal': p, 'creatureGeneration': 1},
};
void main() {
  testWidgets(
    'actual bound sensing sheet presents proposal only after media confirmation',
    (t) async {
      final calls = <String>[];
      final p = proposal();
      final client = MockClient((req) async {
        calls.add(req.url.path);
        if (req.url.path.endsWith('/state')) {
          return http.Response(
            jsonEncode(authorizedSenseState()),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }
        if (req.url.path.endsWith('sense-capabilities')) {
          return http.Response(
            jsonEncode({
              'context': p['context'],
              'capabilities': {
                'hearing': {'available': true},
              },
            }),
            200,
            headers: {'content-type': 'application/json; charset=utf-8'},
          );
        }
        return http.Response(
          jsonEncode({
            'event': event(p),
            'result': {
              'text': '演示地图，从甲站到丙站。',
              'realProcessing': true,
              'engine': 'test',
              'model': 'test',
            },
            'companionReply': {
              'schema': 'creature-reply.v1',
              'creatureId': 'companion',
              'sceneRevision': 3,
              'eventId': 'e1',
              'source': 'deterministic-local',
              'llmUsed': false,
              'text': '仅路线建议',
              'suggestedScene': null,
            },
            'llmUsed': false,
            'voiceAvailable': false,
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      });
      await t.pumpWidget(
        MaterialApp(
          home: CreatureSenseSheet(
            creatureId: 'companion',
            creatureName: '小伴',
            modality: 'hearing',
            client: client,
            capture: FakeCapture(),
          ),
        ),
      );
      await t.pumpAndSettle();
      Future<void> click(String key) async {
        final f = find.byKey(Key(key));
        await t.ensureVisible(f);
        await t.tap(f);
        await t.pumpAndSettle();
      }

      await click('bound-capture');
      await click('bound-capture');
      expect(find.byKey(const Key('spoken-route-confirm')), findsNothing);
      await click('bound-send');
      expect(find.byKey(const Key('spoken-route-confirm')), findsOneWidget);
      expect(calls.where((c) => c.endsWith('sense-route-confirm')), isEmpty);
      await click('spoken-route-confirm');
      expect(
        t
            .widget<FilledButton>(find.byKey(const Key('bound-capture')))
            .onPressed,
        isNull,
      );
      expect(find.byKey(const Key('spoken-route-status')), findsOneWidget);
      expect(find.byKey(const Key('spoken-route-cancel')), findsOneWidget);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      expect(find.byKey(const Key('spoken-route-confirm')), findsNothing);
      expect(
        t
            .widget<TextButton>(find.byKey(const Key('spoken-route-status')))
            .onPressed,
        isNotNull,
      );
      expect(
        t
            .widget<TextButton>(find.byKey(const Key('spoken-route-cancel')))
            .onPressed,
        isNotNull,
      );
      expect(
        t
            .widget<FilledButton>(find.byKey(const Key('bound-capture')))
            .onPressed,
        isNull,
      );
      expect(
        t
            .widget<SwitchListTile>(find.byKey(const Key('bound-send-on-stop')))
            .value,
        false,
      );
    },
  );
  testWidgets('late confirm after card closes never presents receipt', (
    t,
  ) async {
    final hold = Completer<http.Response>();
    var applied = 0;
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SpokenRouteProposalCard(
            proposal: proposal(),
            api: SceneExperimentApi(MockClient((_) => hold.future)),
            onApplied: () => applied++,
          ),
        ),
      ),
    );
    await t.tap(find.byKey(const Key('spoken-route-confirm')));
    await t.pump();
    await t.pumpWidget(const MaterialApp(home: Scaffold()));
    hold.complete(http.Response('{}', 200));
    await t.pumpAndSettle();
    expect(applied, 0);
    expect(t.takeException(), isNull);
  });

  test('closed proposal bound to hearing event; compatible reply only for valid proposal', () {
    final p = proposal(), e = event(proposal());
    expect(validatedSpokenRoute(p, e, 'hearing'), isNotNull);
    final reply = {
      'schema': 'creature-reply.v1',
      'creatureId': 'companion',
      'sceneRevision': 3,
      'eventId': 'e1',
      'source': 'deterministic-local',
      'llmUsed': false,
      'text': '只是建议',
      'suggestedScene': null,
    };
    expect(validatedCreatureReply(reply, e, 'hearing'), isNotNull);
    for (final mutate in <void Function(Map)>[
      (p) => p['action'] = 'run',
      (p) => p['instanceId'] = null,
      (p) => p['providerId'] = 'other',
      (p) => p['from'] = 'GPS',
      (p) => p['requestId'] = 'another',
      (p) => p['context'] = {'creatureId': 'other', 'sceneRevision': 3},
    ]) {
      final bad = proposal();
      mutate(bad);
      expect(validatedSpokenRoute(bad, e, 'hearing'), isNull);
    }
    e['modality'] = 'vision';
    expect(validatedSpokenRoute(p, e, 'vision'), isNull);
    expect(validatedCreatureReply(reply, e, 'vision'), isNull);
  });
  testWidgets('blocked proposal explains manual authorization without calls', (
    t,
  ) async {
    final p = proposal()
      ..['status'] = 'blocked'
      ..['reason'] = 'route_not_granted';
    var calls = 0;
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SpokenRouteProposalCard(
            proposal: p,
            api: SceneExperimentApi(
              MockClient((_) async {
                calls++;
                return http.Response('{}', 200);
              }),
            ),
            onApplied: () {},
          ),
        ),
      ),
    );
    expect(find.byKey(const Key('spoken-route-confirm')), findsNothing);
    expect(find.textContaining('不会自动授权'), findsOneWidget);
    expect(calls, 0);
  });
  testWidgets(
    'explicit confirm binds original proposal and only matched receipt applies',
    (t) async {
      var applied = 0, calls = 0;
      final p = proposal();
      final state = market.state();
      state['route']['receipt']['requestId'] = 'speech-e1';
      final client = MockClient((req) async {
        calls++;
        final body = jsonDecode(req.body);
        expect(body['expectedProposal'], p);
        expect(body['confirmation'], 'request-synthetic-route');
        return http.Response(
          jsonEncode({
            'eventId': 'e1',
            'requestId': 'speech-e1',
            'eventStatus': 'completed',
            'requestStatus': 'completed',
            'receiptId': 'r1',
            'state': state,
            'replayed': false,
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      });
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SpokenRouteProposalCard(
              proposal: p,
              api: SceneExperimentApi(client),
              onApplied: () => applied++,
            ),
          ),
        ),
      );
      expect(calls, 0);
      await t.tap(find.byKey(const Key('spoken-route-confirm')));
      await t.pumpAndSettle();
      expect(applied, 1);
      expect(find.text('A → B → C'), findsOneWidget);
    },
  );
  testWidgets(
    'unknown confirm queries not_started without resending; cancellation stays explicit',
    (t) async {
      final actions = <String>[];
      var applied = 0;
      final client = MockClient((req) async {
        final action = req.url.path.split('/').last;
        actions.add(action);
        if (action == 'sense-route-confirm') throw Exception('lost');
        return http.Response(
          jsonEncode({
            'eventId': 'e1',
            'requestId': 'speech-e1',
            'eventStatus': 'observation',
            'requestStatus': action == 'sense-route-status'
                ? 'not_started'
                : 'cancelled',
            'receiptId': null,
            'state': market.state(),
          }),
          200,
          headers: {'content-type': 'application/json; charset=utf-8'},
        );
      });
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SpokenRouteProposalCard(
              proposal: proposal(),
              api: SceneExperimentApi(client),
              onApplied: () => applied++,
            ),
          ),
        ),
      );
      await t.tap(find.byKey(const Key('spoken-route-confirm')));
      await t.pumpAndSettle();
      expect(find.byKey(const Key('spoken-route-confirm')), findsNothing);
      await t.tap(find.byKey(const Key('spoken-route-status')));
      await t.pumpAndSettle();
      expect(find.textContaining('尚未开始'), findsOneWidget);
      await t.tap(find.byKey(const Key('spoken-route-cancel')));
      await t.pumpAndSettle();
      expect(find.textContaining('已取消'), findsOneWidget);
      expect(applied, 0);
      expect(actions, [
        'sense-route-confirm',
        'sense-route-status',
        'sense-route-cancel',
      ]);
    },
  );
  testWidgets('expired proposal cannot confirm', (t) async {
    final p = proposal()..['expiresAt'] = 1;
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SpokenRouteProposalCard(
            proposal: p,
            api: SceneExperimentApi(
              MockClient((_) async => http.Response('{}', 200)),
            ),
            onApplied: () {},
          ),
        ),
      ),
    );
    expect(
      t
          .widget<FilledButton>(find.byKey(const Key('spoken-route-confirm')))
          .onPressed,
      isNull,
    );
  });
}
