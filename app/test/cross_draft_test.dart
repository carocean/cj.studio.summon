import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/creature_sense.dart';
import 'package:summon_app/temporary_interaction.dart';

import 'creature_home_minimal_test.dart' as home;
import 'temporary_interaction_test.dart' as temp;
import 'perception_test.dart' show FakeCapture;

void main() {
  testWidgets(
    'read but never shown session cannot acquire retained resume authority',
    (t) async {
      final controller = CreatureHomeController(),
          view = temp.fixture(),
          state = home.state();
      final read = Completer<http.Response>();
      var pointer = view['sessionId'];
      final client = MockClient((r) async {
        if (r.url.path.endsWith('/usage') ||
            r.url.path.split('/').last.startsWith('usage-')) {
          return http.Response('{"error":"usage_fixture_disabled"}', 400);
        }
        final action = r.url.path.split('/').last;
        if (action == 'state') return home.response(state);
        if (action == 'interaction-current') {
          return home.response({
            'sessionId': pointer,
            'context': state['context'],
          });
        }
        if (action == 'interaction-read') return read.future;
        throw StateError('Unexpected action');
      });
      await t.pumpWidget(
        MaterialApp(
          home: CreatureHome(controller: controller, client: client),
        ),
      );
      await home.idle(t);
      final pending = controller.presentInteraction(view['sessionId']);
      await home.idle(t);
      final navigator = Navigator.of(t.element(find.byType(CreatureHome)));
      unawaited(
        navigator.push(
          MaterialPageRoute<void>(
            builder: (_) => const Scaffold(body: Text('new route')),
          ),
        ),
      );
      await home.idle(t);
      read.complete(home.response(view));
      await home.idle(t);
      expect(await pending, CreaturePresentationResult.stale);
      expect(find.text('new route'), findsOneWidget);
      navigator.pop();
      await home.idle(t);
      pointer = 'different-current';
      expect(
        await controller.resumeInteraction(view['sessionId']),
        CreaturePresentationResult.blocked,
      );
      final discovery = controller.presentInteraction(view['sessionId']);
      await home.idle(t);
      expect(await discovery, CreaturePresentationResult.blocked);
      await t.pumpWidget(const SizedBox());
      client.close();
    },
  );

  for (final mode in [
    'dirty',
    'transient-read-failure',
    'microphone-off',
    'expired',
    'revision',
    'scene',
    'denied',
    'pending',
  ]) {
    testWidgets('pause and explicit user return preserves $mode', (t) async {
      final b = temp.Backend(),
          controller = CreatureHomeController(),
          capture = FakeCapture();
      final state = home.state();
      var deny = false;
      final client = MockClient((r) async {
        if (r.url.path.endsWith('/usage') ||
            r.url.path.split('/').last.startsWith('usage-')) {
          return http.Response('{"error":"usage_fixture_disabled"}', 400);
        }
        if (r.url.path.endsWith('/state')) return home.response(state);
        if (r.url.path.endsWith('sense-capabilities')) {
          return home.response({
            'context': state['context'],
            'capabilities': {
              'hearing': {'available': true},
            },
          });
        }
        if (deny && r.url.path.endsWith('interaction-read')) {
          return http.Response('{"error":"unauthenticated"}', 403);
        }
        final copy = http.Request(r.method, r.url)
          ..headers.addAll(r.headers)
          ..bodyBytes = r.bodyBytes;
        return http.Response.fromStream(await b.client.send(copy));
      });
      await t.pumpWidget(
        MaterialApp(
          home: CreatureHome(
            controller: controller,
            client: client,
            senseCaptureFactory: () => capture,
          ),
        ),
      );
      await home.idle(t);
      expect(
        await controller.resumeInteraction('unknown'),
        CreaturePresentationResult.blocked,
      );
      final open = controller.presentInteraction(b.view['sessionId']);
      await home.idle(t);
      expect(await open, CreaturePresentationResult.shown);
      await home.idle(t);
      await temp.fill(t);
      if (mode == 'transient-read-failure') {
        final draft = t
            .widget<TemporaryInteractionSheet>(
              find.byType(TemporaryInteractionSheet),
            )
            .recovery;
        draft.stale = true;
        draft.message = 'Earlier read was unavailable';
      }
      if (mode == 'pending') {
        b.holdEdit = Completer<http.Response>();
        await t.ensureVisible(find.byKey(const Key('interaction-update')));
        await t.tap(find.byKey(const Key('interaction-update')));
        await t.pump();
      }
      await temp.tap(t, 'interaction-new-need');
      expect(find.byType(CreatureSenseSheet), findsOneWidget);
      expect(capture.starts, 0);
      b.noCurrent =
          true; // A latest pointer is not authorization for a retained draft.
      if (mode == 'microphone-off') {
        (state['creatures'] as List).firstWhere(
          (c) => c['id'] == 'companion',
        )['senses']['hearing'] = false;
      }
      if (mode == 'expired') {
        b.view['expiresAt'] = DateTime.now().millisecondsSinceEpoch - 1;
      }
      if (mode == 'revision') {
        b.view['revision']++;
        b.view['draft']['revision']++;
      }
      if (mode == 'scene') {
        state['context'] = {'creatureId': 'companion', 'sceneRevision': 2};
      }
      if (mode == 'denied') deny = true;
      await t.ensureVisible(find.byKey(const Key('hearing-return-draft')));
      await t.tap(find.byKey(const Key('hearing-return-draft')));
      await home.idle(t);
      await home.idle(t);
      expect(find.byType(TemporaryInteractionSheet), findsOneWidget);
      final field = t.widget<TextField>(
        find.byKey(const ValueKey('interaction-subject')),
      );
      expect(field.controller!.text, '😀界');
      expect(
        field.readOnly,
        !['dirty', 'microphone-off', 'transient-read-failure'].contains(mode),
      );
      expect(b.writes.length, mode == 'pending' ? 1 : 0);
      if (mode == 'pending') {
        expect(b.queries.single, b.writes.single['commandId']);
        b.holdEdit!.complete(home.response({'replayed': false, 'ack': {}}));
        await t.pump();
        expect(field.controller!.text, '😀界');
      }
      await t.pumpWidget(const SizedBox());
      client.close();
      b.client.close();
    });
  }
  testWidgets(
    'new host-generated session retains user return link and both unsaved drafts',
    (t) async {
      final controller = CreatureHomeController(),
          capture = FakeCapture(),
          state = home.state();
      final old = temp.fixture(),
          next = temp.fixture()..['sessionId'] = 'session-next';
      var current = old['sessionId'];
      final writes = <String>[];
      final client = MockClient((r) async {
        if (r.url.path.endsWith('/usage') ||
            r.url.path.split('/').last.startsWith('usage-')) {
          return http.Response('{"error":"usage_fixture_disabled"}', 400);
        }
        final action = r.url.path.split('/').last;
        if (action == 'state') return home.response(state);
        if (action == 'sense-capabilities') {
          return home.response({
            'context': state['context'],
            'capabilities': {
              'hearing': {'available': true},
            },
          });
        }
        if (action == 'interaction-current') {
          return home.response({
            'sessionId': current,
            'context': state['context'],
          });
        }
        if (action == 'interaction-read') {
          return home.response(
            jsonDecode(r.body)['sessionId'] == old['sessionId'] ? old : next,
          );
        }
        writes.add(action);
        throw StateError('No mutation expected');
      });
      await t.pumpWidget(
        MaterialApp(
          home: CreatureHome(
            controller: controller,
            client: client,
            senseCaptureFactory: () => capture,
          ),
        ),
      );
      await home.idle(t);
      final open = controller.presentInteraction(old['sessionId']);
      await home.idle(t);
      expect(await open, CreaturePresentationResult.shown);
      await home.idle(t);
      await t.enterText(
        find.byKey(const ValueKey('interaction-subject')),
        '旧稿',
      );
      await temp.tap(t, 'interaction-new-need');
      expect(capture.starts, 0);
      final sense = t.widget<CreatureSenseSheet>(
        find.byType(CreatureSenseSheet),
      );
      final c = (state['creatures'] as List).firstWhere(
        (c) => c['id'] == 'companion',
      );
      current = next['sessionId'];
      final result = sense.onOpenInteraction!(
        t.element(find.byType(CreatureSenseSheet)),
        current,
        Map<String, dynamic>.from(state['context']),
        {
          'frame': state['context'],
          'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
          'metadata': {'creatureGeneration': c['generation']},
        },
      );
      await home.idle(t);
      expect(await result, true);
      await home.idle(t);
      await t.enterText(
        find.byKey(const ValueKey('interaction-subject')),
        '新稿',
      );
      await temp.tap(t, 'interaction-return-draft');
      expect(
        t
            .widget<TextField>(
              find.byKey(const ValueKey('interaction-subject')),
            )
            .controller!
            .text,
        '旧稿',
      );
      expect(
        t
            .widget<TextField>(
              find.byKey(const ValueKey('interaction-subject')),
            )
            .readOnly,
        false,
      );
      expect(
        await controller.present(CreatureIntent.account),
        CreaturePresentationResult.blocked,
      );
      controller.dismiss();
      await home.idle(t);
      final reopen = controller.resumeInteraction(current);
      await home.idle(t);
      expect(await reopen, CreaturePresentationResult.shown);
      await home.idle(t);
      expect(
        t
            .widget<TextField>(
              find.byKey(const ValueKey('interaction-subject')),
            )
            .controller!
            .text,
        '新稿',
      );
      expect(writes, isEmpty);
      await t.pumpWidget(const SizedBox());
      client.close();
    },
  );
}
