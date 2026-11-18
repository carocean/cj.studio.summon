import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/hearing_interaction.dart';
import 'package:summon_app/media_captions.dart';
import 'package:summon_app/creature_sense.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/temporary_interaction.dart';

import 'creature_home_minimal_test.dart' as home;
import 'temporary_interaction_test.dart' as temporary;

import 'creature_sense_test.dart' as sense;
import 'perception_test.dart' show FakeCapture;

const source = {
  'eventId': 'p-11111111-1111-1111-1111-111111111111',
  'context': {'creatureId': 'companion', 'sceneRevision': 3},
};
Map<String, dynamic> result() {
  final program = jsonDecode(
    File('test/fixtures/interaction-program.json').readAsStringSync(),
  )['initial']['program'];
  return {
    'schema': 'hearing-interaction-generation.v1',
    ...source,
    'kind': 'form',
    'creation': {
      'status': 'completed',
      'commandId': 'fixture-create',
      'ack': {
        'fact': 'interaction_created',
        'sessionId': 'fixture-session',
        'revision': 1,
        'draftRevision': 0,
        'expiresAt': DateTime.now().millisecondsSinceEpoch + 300000,
        'programDigest': program['programDigest'],
      },
    },
    'proposal': {
      'kind': 'form',
      'program': program,
      'authorityGranted': false,
      'semanticsVerified': false,
    },
    'replayed': false,
    'modelId': 'fixture',
    'sourceTrust': 'host-supplied-metadata',
    'plannerInvoked': true,
    'speech': null,
    'voiceAvailable': false,
  };
}

class AbortClient extends http.BaseClient {
  bool aborted = false;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest r) async {
    await (r as http.AbortableRequest).abortTrigger;
    aborted = true;
    throw http.RequestAbortedException(r.url);
  }
}

class StreamingClient extends http.BaseClient {
  final StreamController<List<int>> body;
  StreamingClient(this.body);
  @override
  Future<http.StreamedResponse> send(http.BaseRequest r) async =>
      http.StreamedResponse(body.stream, 200);
}

void main() {
  test('strict creation envelope does not confer semantics or speech', () {
    expect(validatedHearingGeneration(result(), source), isNotNull);
    for (final mutate in <void Function(Map)>[
      (r) => r['speech'] = 'invented',
      (r) => r['modelId'] = '\ud800',
      (r) => r['modelId'] = 'bad\nmodel',
      (r) => r['voiceAvailable'] = true,
      (r) => r['context']['sceneRevision'] = 4,
      (r) => r['eventId'] = 'other',
      (r) => r['creation']['ack']['draftRevision'] = 0.0,
      (r) => r['proposal']['authorityGranted'] = true,
      (r) => r['creation']['ack']['programDigest'] = 'sha256:${'0' * 64}',
      (r) => r['extra'] = true,
    ]) {
      final r = jsonDecode(jsonEncode(result())) as Map;
      mutate(r);
      expect(validatedHearingGeneration(r, source), isNull);
    }
  });
  test(
    'cancellation reaches AbortableRequest, not just a Future timeout',
    () async {
      final c = AbortClient(), cancel = Completer<void>();
      final f = generateHearingInteraction(c, source, cancel.future);
      final check = expectLater(
        f,
        throwsA(isA<http.RequestAbortedException>()),
      );
      cancel.complete();
      await check;
      expect(c.aborted, true);
    },
  );
  test('body subscription is cancelled on withdrawal without retaining late chunks', () async {
    var cancelled = false;
    final body = StreamController<List<int>>(
      onCancel: () {
        cancelled = true;
      },
    );
    final client = StreamingClient(body), abort = Completer<void>();
    final pending = generateHearingInteraction(client, source, abort.future);
    final checked = expectLater(
      pending,
      throwsA(isA<http.RequestAbortedException>()),
    );
    await Future<void>.delayed(Duration.zero);
    body.add(utf8.encode('{'));
    abort.complete();
    await checked;
    expect(cancelled, true);
    await body.close();
    client.close();
  });
  for (final scenario in ['oversize', 'utf8', 'redirect']) {
    test(
      'bounded transport rejects $scenario without following redirects',
      () async {
        var calls = 0;
        final client = MockClient((r) async {
          if (r.url.path.endsWith('/usage') ||
              r.url.path.split('/').last.startsWith('usage-')) {
            return http.Response('{"error":"usage_fixture_disabled"}', 400);
          }
          calls++;
          expect(r.followRedirects, false);
          if (scenario == 'oversize') {
            return http.Response.bytes(List.filled(131073, 32), 200);
          }
          if (scenario == 'utf8') return http.Response.bytes([255], 200);
          return http.Response(
            '{}',
            302,
            headers: {'location': 'https://example.invalid'},
          );
        });
        await expectLater(
          generateHearingInteraction(client, source, Completer<void>().future),
          throwsA(anything),
        );
        expect(calls, 1);
        client.close();
      },
    );
  }
  for (final handoff in ['show', 'revoke-during-read', 'new-route']) {
    testWidgets(
      'Home generation handoff $handoff never replaces another route',
      (t) async {
        final b = sense.SenseBackend()..candidate = null;
        final controller = CreatureHomeController();
        final session = temporary.fixture()..['context'] = source['context'];
        var revoke = false;
        final reading = Completer<http.Response>();
        final client = MockClient((r) async {
          if (r.url.path.endsWith('/usage') ||
              r.url.path.split('/').last.startsWith('usage-')) {
            return http.Response('{"error":"usage_fixture_disabled"}', 400);
          }
          if (r.url.path.endsWith('interaction-generate')) {
            return b.reply(result());
          }
          if (r.url.path.endsWith('interaction-current')) {
            return b.reply({
              'sessionId': 'fixture-session',
              'context': source['context'],
            });
          }
          if (r.url.path.endsWith('interaction-read')) {
            if (handoff == 'revoke-during-read') revoke = true;
            if (handoff == 'new-route') return reading.future;
            return b.reply(session);
          }
          if (r.url.path.endsWith('/state')) {
            final state = {...home.state(), ...sense.authorizedSenseState()};
            if (revoke) {
              (state['creatures'] as List)[0]['senses']['hearing'] = false;
            }
            return b.reply(state);
          }
          final copy = http.Request(r.method, r.url)
            ..headers.addAll(r.headers)
            ..bodyBytes = r.bodyBytes;
          final response = await http.Response.fromStream(
            await b.client.send(copy),
          );
          final data = jsonDecode(response.body);
          if (r.url.path.endsWith('/sense')) {
            data['event']['eventId'] = source['eventId'];
            data['event']['metadata']['realProcessing'] = true;
            data['companionReply']['eventId'] = source['eventId'];
          }
          return b.reply(data);
        });
        await t.pumpWidget(
          MaterialApp(
            home: CreatureHome(
              controller: controller,
              client: client,
              senseCaptureFactory: FakeCapture.new,
              enableHearingInteraction: true,
            ),
          ),
        );
        await home.idle(t);
        final opening = controller.present(CreatureIntent.hearing);
        await home.idle(t);
        expect(await opening, CreaturePresentationResult.shown);
        await sense.capture(t);
        await sense.tap(t, 'bound-send');
        await sense.tap(t, 'hearing-generate');
        if (handoff == 'new-route') {
          await t.ensureVisible(
            find.byKey(const Key('hearing-generation-open')),
          );
          await t.tap(find.byKey(const Key('hearing-generation-open')));
          await home.idle(t);
          final next = controller.present(CreatureIntent.hearing);
          await home.idle(t);
          expect(await next, CreaturePresentationResult.shown);
          reading.complete(b.reply(session));
          await home.idle(t);
          expect(find.byType(CreatureSenseSheet), findsOneWidget);
          expect(find.byType(TemporaryInteractionSheet), findsNothing);
        } else {
          await t.ensureVisible(
            find.byKey(const Key('hearing-generation-open')),
          );
          await t.tap(find.byKey(const Key('hearing-generation-open')));
          await home.idle(t);
          expect(
            find.byType(TemporaryInteractionSheet),
            handoff == 'show' ? findsOneWidget : findsNothing,
          );
          if (handoff == 'show') {
            await t.enterText(
              find.byKey(const ValueKey('interaction-subject')),
              '保留',
            );
            expect(
              await controller.present(CreatureIntent.hearing),
              CreaturePresentationResult.blocked,
            );
            expect(
              t
                  .widget<TextField>(
                    find.byKey(const ValueKey('interaction-subject')),
                  )
                  .controller!
                  .text,
              '保留',
            );
          }
        }
        await t.pumpWidget(const SizedBox());
        client.close();
        b.client.close();
      },
    );
  }
  for (final mode in [
    'default',
    'success',
    'cancel',
    'background',
    'scene',
    'permission',
    'next-round',
    'unknown',
    'disabled',
    'state-failure',
    'post-revoke',
    'post-expired',
    'post-subject',
    'post-boundary',
    'post-cancel',
    'open-permission',
    'open-failure',
    'expired',
    'clarify-ttl',
    'clarify-background',
  ]) {
    for (final withCaptions in [false, true]) {
      testWidgets('explicit hearing generation $mode captions=$withCaptions', (
        t,
      ) async {
        final b = sense.SenseBackend()..candidate = null;
        final hold = Completer<http.Response>();
        var generated = 0, opened = 0, revoke = false, stateFailure = false;
        final captions = withCaptions
            ? (BoundMediaCaptions()..bind(sense.authorizedSenseState()))
            : null;
        final client = MockClient((r) async {
          if (r.url.path.endsWith('/usage') ||
              r.url.path.split('/').last.startsWith('usage-')) {
            return http.Response('{"error":"usage_fixture_disabled"}', 400);
          }
          if (r.url.path.endsWith('interaction-generate')) {
            generated++;
            expect(jsonDecode(r.body), source);
            if (mode.startsWith('post-')) {
              return b.reply({
                'error': {
                  'post-revoke': 'authorization_changed',
                  'post-expired': 'sensory_event_expired',
                  'post-subject': 'subject_not_active',
                  'post-boundary': 'outside_sensory_boundary',
                  'post-cancel': 'interaction_generation_cancelled',
                }[mode],
              }, 400);
            }
            if (mode == 'unknown') throw http.ClientException('lost response');
            if (mode == 'disabled') {
              return b.reply({'error': 'interaction_planner_unavailable'}, 400);
            }
            return hold.future;
          }
          if (stateFailure && r.url.path.endsWith('/state')) {
            throw http.ClientException('state unavailable');
          }
          final copy = http.Request(r.method, r.url)
            ..headers.addAll(r.headers)
            ..bodyBytes = r.bodyBytes;
          final response = await http.Response.fromStream(
            await b.client.send(copy),
          );
          final data = jsonDecode(response.body);
          if (r.url.path.endsWith('/sense')) {
            data['event']['eventId'] = source['eventId'];
            data['event']['metadata']['realProcessing'] = true;
            if (mode == 'expired') {
              data['event']['expiresAt'] =
                  DateTime.now().millisecondsSinceEpoch + 1000;
            }
            data['companionReply']['eventId'] = source['eventId'];
          }
          if (revoke && r.url.path.endsWith('/state')) {
            data['creatures'][0]['senses']['hearing'] = false;
          }
          return b.reply(data);
        });
        await t.pumpWidget(
          MaterialApp(
            home: CreatureSenseSheet(
              creatureId: 'companion',
              creatureName: '小伴',
              modality: 'hearing',
              client: client,
              capture: FakeCapture(),
              voicePlayer: sense.FakeVoicePlayer(),
              enableInteractionGeneration: mode != 'default',
              captions: captions,
              onOpenInteraction: (_, _, _, _) async {
                opened++;
                return true;
              },
            ),
          ),
        );
        await t.pumpAndSettle();
        await sense.capture(t);
        await sense.tap(t, 'bound-send');
        if (mode == 'default') {
          expect(find.byKey(const Key('hearing-generate')), findsNothing);
        } else {
          await t.ensureVisible(find.byKey(const Key('hearing-generate')));
          await t.tap(find.byKey(const Key('hearing-generate')));
          await t.pump();
          await t.pump(const Duration(milliseconds: 20));
          expect(generated, 1);
          if (mode == 'cancel') await sense.tap(t, 'hearing-generation-cancel');
          if (mode == 'background') {
            t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
            await t.pump();
          }
          if (mode == 'scene') b.revision = 4;
          if (mode == 'permission') revoke = true;
          if (mode == 'state-failure') stateFailure = true;
          if (mode == 'expired') {
            await t.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 1100)),
            );
          }
          if (mode == 'next-round') await sense.tap(t, 'bound-capture');
          final generatedResult = result();
          if (mode.startsWith('clarify-')) {
            generatedResult['kind'] = 'clarify';
            generatedResult['creation'] = null;
            generatedResult['proposal'] = {
              'kind': 'clarify',
              'question': 'PRIVATE-UNIQUE-QUESTION',
              'authorityGranted': false,
              'semanticsVerified': false,
            };
          }
          hold.complete(b.reply(generatedResult));
          await t.pumpAndSettle();
          if (['success', 'open-permission', 'open-failure'].contains(mode)) {
            expect(opened, 0);
            expect(
              find.byKey(const Key('hearing-generation-open')),
              findsOneWidget,
            );
            if (mode == 'open-permission') revoke = true;
            if (mode == 'open-failure') stateFailure = true;
            await sense.tap(t, 'hearing-generation-open');
            expect(opened, mode == 'success' ? 1 : 0);
          } else {
            expect(
              find.byKey(const Key('hearing-generation-open')),
              findsNothing,
            );
            expect(opened, 0);
          }
          if ([
            'permission',
            'scene',
            'state-failure',
            'post-revoke',
            'post-expired',
            'post-subject',
            'post-boundary',
            'post-cancel',
            'open-permission',
            'open-failure',
            'expired',
          ].contains(mode)) {
            expect(find.byKey(const Key('bound-observation')), findsNothing);
            expect(find.byKey(const Key('bound-creature-reply')), findsNothing);
            expect(
              find.byKey(const Key('hearing-generation-open')),
              findsNothing,
            );
            expect(captions?.userText, isNull);
          }
          expect(generated, 1);
          if (mode.startsWith('clarify-')) {
            expect(
              find.textContaining('PRIVATE-UNIQUE-QUESTION'),
              findsOneWidget,
            );
            if (mode == 'clarify-ttl') {
              await t.pump(const Duration(seconds: 61));
            } else {
              for (final state in [
                AppLifecycleState.inactive,
                AppLifecycleState.hidden,
                AppLifecycleState.paused,
                AppLifecycleState.hidden,
                AppLifecycleState.inactive,
                AppLifecycleState.resumed,
              ]) {
                t.binding.handleAppLifecycleStateChanged(state);
              }
              await t.pump();
            }
            expect(
              find.textContaining('PRIVATE-UNIQUE-QUESTION'),
              findsNothing,
            );
            expect(find.byKey(const Key('bound-observation')), findsNothing);
            expect(captions?.userText, isNull);
          }
          if (mode == 'unknown') {
            expect(find.text('结果待核查；不会重发生成请求或恢复权限。'), findsOneWidget);
          }
          if (mode == 'disabled') {
            expect(find.text('宿主未启用模型生成。未生成界面。'), findsOneWidget);
          }
        }
        await t.pumpWidget(const SizedBox());
        if (mode == 'background' || mode == 'clarify-background') {
          t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        }
        client.close();
        b.client.close();
        captions?.dispose();
      });
    }
  }
}
