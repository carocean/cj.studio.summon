import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/temporary_interaction.dart';
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/standin_avatar.dart';

import 'creature_home_minimal_test.dart' as home;

Map<String, dynamic> fixture() {
  final v =
      jsonDecode(
            File('test/fixtures/interaction-program.json').readAsStringSync(),
          )['initial']
          as Map<String, dynamic>;
  v['createdAt'] = DateTime.now().millisecondsSinceEpoch;
  v['expiresAt'] = v['createdAt'] + 300000;
  return v;
}

class Backend {
  Map<String, dynamic> view = fixture();
  final writes = <Map<String, dynamic>>[];
  final receipts = <String, Map<String, dynamic>>{};
  bool loseSave = false, loseClose = false, noCurrent = false;
  final queries = <String>[];
  final reads = <String>[];
  bool floatingDraftRevision = false;
  Map<String, dynamic>? stateContext;
  Completer<http.Response>? holdEdit;
  late final client = MockClient((r) async {
    final action = r.url.path.split('/').last;
    reads.add(action);
    if (action == 'usage') {
      return home.response({
        'schema': 'real-usage-history.v1',
        'items': [],
        'learningSaturated': false,
        'minUses': 2,
        'sourceTrust': 'host-actions-and-client-presentation-reports',
      });
    }
    if (action.startsWith('usage-')) {
      return http.Response('{"error":"usage_fixture_disabled"}', 400);
    }
    if (action == 'state') {
      return home.response({
        ...home.state(),
        'context': stateContext ?? view['context'],
      });
    }
    if (action == 'interaction-current') {
      if (noCurrent) {
        return http.Response(
          'null',
          200,
          headers: {'content-type': 'application/json'},
        );
      }
      return home.response({
        'sessionId': view['sessionId'],
        'context': view['context'],
      });
    }
    final body = jsonDecode(r.body) as Map<String, dynamic>;
    if (action == 'interaction-read') return home.response(view);
    if (action == 'interaction-query') {
      queries.add(body['commandId']);
      return home.response(
        receipts.containsKey(body['commandId'])
            ? {
                'status': 'completed',
                'commandId': body['commandId'],
                'ack': receipts[body['commandId']],
              }
            : {'status': 'not_started', 'commandId': body['commandId']},
      );
    }
    writes.add({'action': action, ...body});
    if (action == 'interaction-edit' && holdEdit != null) {
      return holdEdit!.future;
    }
    final op = action.substring('interaction-'.length);
    if (body['expectedRevision'] != view['revision']) {
      return http.Response('{"error":"interaction_revision_conflict"}', 409);
    }
    view['revision']++;
    if (op == 'edit') {
      view['draft']['values'] = <String, dynamic>{
        ...view['draft']['values'],
        ...body['changes'],
      };
      view['draft']['revision']++;
      view['changeCount']++;
    }
    final ack = <String, dynamic>{
      'fact': op == 'edit'
          ? 'interaction_draft_updated'
          : op == 'save'
          ? 'local_note_saved'
          : 'interaction_presentation_closed',
      'sessionId': view['sessionId'],
      'revision': view['revision'],
      if (op != 'close') ...{
        'programDigest': view['program']['programDigest'],
        'draftRevision': floatingDraftRevision
            ? (view['draft']['revision'] as int).toDouble()
            : view['draft']['revision'],
      },
      if (op == 'save') ...{
        'noteId': 'note-one',
        'noteDigest': 'sha256:${'a' * 64}',
        'savedAt': DateTime.now().millisecondsSinceEpoch,
      },
    };
    if (op == 'save') {
      view['saveCount']++;
      view['lastNoteId'] = 'note-one';
    }
    receipts[body['commandId']] = ack;
    if (op == 'close' && loseClose) {
      noCurrent = true;
      throw http.ClientException('lost close receipt');
    }
    if (op == 'save' && loseSave) {
      throw http.ClientException('lost response after commit');
    }
    return home.response({'replayed': false, 'ack': ack});
  });
}

Future<void> tap(WidgetTester t, String key) async {
  final f = find.byKey(Key(key));
  await t.ensureVisible(f);
  await t.tap(f);
  await t.pumpAndSettle();
}

Future<void> mount(WidgetTester t, Backend b, InteractionDraftState d) async {
  await t.pumpWidget(
    MaterialApp(
      home: TemporaryInteractionSheet(
        api: SceneExperimentApi(b.client),
        sessionId: b.view['sessionId'],
        contextBinding: Map<String, dynamic>.from(b.view['context']),
        recovery: d,
      ),
    ),
  );
  await t.pumpAndSettle();
}

Future<void> fill(WidgetTester t) async {
  await t.enterText(find.byKey(const ValueKey('interaction-subject')), '😀界');
  await t.enterText(
    find.byKey(const ValueKey('interaction-body')),
    '<b>plain</b>\nline',
  );
  final choice = find.byType(DropdownButtonFormField<String>);
  await t.ensureVisible(choice);
  await t.tap(choice);
  await t.pumpAndSettle();
  await t.tap(find.text('高').last);
  await t.pumpAndSettle();
}

void main() {
  testWidgets(
    'generic declaration order/types/literal text, explicit edit then separate save',
    (t) async {
      final b = Backend(), d = InteractionDraftState();
      await mount(t, b, d);
      expect(find.text('临时 <表单> 😀'), findsOneWidget);
      expect(find.byType(TextField), findsNWidgets(2));
      expect(d.values.values.every((v) => v == null), true);
      expect(b.writes, isEmpty);
      await fill(t);
      expect(d.values['subject'], '😀界');
      await t.enterText(
        find.byKey(const ValueKey('interaction-subject')),
        '😀界多',
      );
      expect(d.values['subject'], '😀界');
      await tap(t, 'interaction-update');
      expect(b.writes.length, 1);
      expect(d.dirty, false);
      await tap(t, 'interaction-save');
      expect(b.writes.length, 2);
      expect(b.writes.last['confirmation'], 'save-local-draft');
      expect(find.byKey(const Key('interaction-receipt')), findsOneWidget);
      await tap(t, 'interaction-close');
      expect(d.closed, true);
      expect(d.receipt?['noteId'], 'note-one');
      await t.pumpWidget(const SizedBox());
      b.client.close();
    },
  );
  testWidgets(
    'lost save response queries exact original command and never creates a second save',
    (t) async {
      final b = Backend()..loseSave = true, d = InteractionDraftState();
      await mount(t, b, d);
      await fill(t);
      await tap(t, 'interaction-update');
      await tap(t, 'interaction-save');
      final id = d.pending!['body']['commandId'];
      expect(d.pending, isNotNull);
      await tap(t, 'interaction-query');
      expect(d.pending, null);
      expect(d.receipt?['noteId'], 'note-one');
      expect(
        b.writes.where((x) => x['action'] == 'interaction-save').length,
        1,
      );
      expect(b.receipts.containsKey(id), true);
      await t.pumpWidget(const SizedBox());
      b.client.close();
    },
  );
  testWidgets(
    'late edit reply after leaving cannot overwrite kept local recovery; reopen queries only',
    (t) async {
      final b = Backend()..holdEdit = Completer<http.Response>(),
          d = InteractionDraftState();
      await mount(t, b, d);
      await fill(t);
      await t.ensureVisible(find.byKey(const Key('interaction-update')));
      await t.tap(find.byKey(const Key('interaction-update')));
      await t.pump();
      final original = Map.of(d.values);
      await t.pumpWidget(const SizedBox());
      b.holdEdit!.complete(home.response({'replayed': false, 'ack': {}}));
      await t.pump();
      expect(d.values, original);
      expect(d.pending, isNotNull);
      await mount(t, b, d);
      expect(d.pending, isNotNull);
      expect(b.writes.length, 1);
      expect(d.values, original);
      await t.pumpWidget(const SizedBox());
      b.client.close();
    },
  );
  testWidgets(
    'external revision never replaces dirty input; expired input remains read-only',
    (t) async {
      final b = Backend(), d = InteractionDraftState();
      await mount(t, b, d);
      await fill(t);
      final original = Map.of(d.values);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await t.pump();
      b.view['revision']++;
      b.view['draft']['revision']++;
      b.view['changeCount']++;
      b.view['draft']['values']['subject'] = '外部';
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      expect(d.stale, true);
      expect(d.values, original);
      expect(
        t
            .widget<TextField>(
              find.byKey(const ValueKey('interaction-subject')),
            )
            .readOnly,
        true,
      );
      await t.pumpWidget(const SizedBox());
      b.client.close();
    },
  );
  testWidgets(
    'Home only opens on-demand current session and refuses replacement without losing draft',
    (t) async {
      final b = Backend(), controller = CreatureHomeController();
      await t.pumpWidget(
        MaterialApp(
          home: CreatureHome(client: b.client, controller: controller),
        ),
      );
      await home.idle(t);
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(StandInAvatar), findsOneWidget);
      final pending = controller.presentInteraction(
        b.view['sessionId'],
        expectedContext: Map<String, dynamic>.from(b.view['context']),
      );
      await home.idle(t);
      expect(await pending, CreaturePresentationResult.shown);
      await home.idle(t);
      await t.enterText(
        find.byKey(const ValueKey('interaction-subject')),
        '留下',
      );
      expect(
        await controller.present(CreatureIntent.textInput),
        CreaturePresentationResult.blocked,
      );
      await t.tap(find.byKey(const Key('interaction-hide')));
      await home.idle(t);
      await home.idle(t);
      expect(find.byType(TextField), findsNothing);
      final reopen = controller.presentInteraction(b.view['sessionId']);
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
        '留下',
      );
      expect(b.writes, isEmpty);
      await t.pumpWidget(const SizedBox());
      b.client.close();
    },
  );
  for (final operation in ['edit', 'save']) {
    testWidgets('rejects floating draft revision in $operation ack and query', (
      t,
    ) async {
      final b = Backend(), d = InteractionDraftState();
      await mount(t, b, d);
      await fill(t);
      if (operation == 'save') await tap(t, 'interaction-update');
      final original = Map.of(d.values);
      b.floatingDraftRevision = true;
      await tap(
        t,
        operation == 'edit' ? 'interaction-update' : 'interaction-save',
      );
      final commandId = d.pending!['body']['commandId'];
      final writeCount = b.writes.length;
      expect(d.receipt, isNull);
      await tap(t, 'interaction-query');
      expect(d.pending!['body']['commandId'], commandId);
      expect(d.values, original);
      expect(d.receipt, isNull);
      expect(b.writes.length, writeCount);
      expect(b.queries.last, commandId);
      await t.pumpWidget(const SizedBox());
      b.client.close();
    });
  }
  for (final operation in [
    'save',
    'close',
    'unknown',
    'dirty',
    'expired',
    'scene',
  ]) {
    testWidgets(
      'Home historical recovery remains reachable after $operation and host no longer current',
      (t) async {
        final b = Backend(), controller = CreatureHomeController();
        await t.pumpWidget(
          MaterialApp(
            home: CreatureHome(client: b.client, controller: controller),
          ),
        );
        await home.idle(t);
        var opening = controller.presentInteraction(b.view['sessionId']);
        await home.idle(t);
        expect(await opening, CreaturePresentationResult.shown);
        await home.idle(t);
        await fill(t);
        if (['save', 'close', 'unknown'].contains(operation)) {
          await tap(t, 'interaction-update');
          b.loseSave = operation == 'save' || operation == 'unknown';
          b.loseClose = operation == 'close';
          await tap(
            t,
            'interaction-${operation == 'unknown' ? 'save' : operation}',
          );
          if (operation == 'unknown') b.receipts.clear();
        }
        final writes = b.writes.length;
        await t.tap(find.byKey(const Key('interaction-hide')));
        await home.idle(t);
        if (operation == 'scene') {
          b.stateContext = {...b.view['context'], 'sceneRevision': 2};
        } else if (operation == 'expired') {
          b.view['expiresAt'] = DateTime.now().millisecondsSinceEpoch - 1;
        } else {
          b.noCurrent = true;
          if (operation == 'dirty') b.view['status'] = 'expired';
        }
        final readCount = b.reads.length;
        opening = controller.presentInteraction(b.view['sessionId']);
        await home.idle(t);
        expect(await opening, CreaturePresentationResult.shown);
        await home.idle(t);
        expect(
          find.byKey(const Key('interaction-recovery-only')),
          findsOneWidget,
        );
        expect(
          t
              .widget<TextField>(
                find.byKey(const ValueKey('interaction-subject')),
              )
              .controller!
              .text,
          '😀界',
        );
        expect(
          t
              .widget<TextField>(
                find.byKey(const ValueKey('interaction-subject')),
              )
              .readOnly,
          true,
        );
        expect(
          t
              .widget<FilledButton>(find.byKey(const Key('interaction-save')))
              .onPressed,
          null,
        );
        expect(b.writes.length, writes);
        if (['save', 'close', 'unknown'].contains(operation)) {
          expect(b.queries.single, b.writes.last['commandId']);
          expect(b.reads.sublist(readCount), ['interaction-query']);
        }
        if (operation == 'unknown') {
          expect(find.byKey(const Key('interaction-command')), findsOneWidget);
          await tap(t, 'interaction-query');
          expect(b.writes.length, writes);
        }
        if (operation == 'save') {
          expect(find.byKey(const Key('interaction-receipt')), findsOneWidget);
        }
        if (operation == 'close') {
          expect(find.text('临时会话已关闭，已保存的本地副本不会被删除。'), findsOneWidget);
        }
        await t.pumpWidget(const SizedBox());
        b.client.close();
      },
    );
  }
}
