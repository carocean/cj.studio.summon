import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/temporary_interaction.dart';
import 'package:summon_app/text_interaction.dart';
import 'package:summon_app/text_interaction_sheet.dart';

import 'creature_home_minimal_test.dart' as home;
import 'temporary_interaction_test.dart' as temp;

http.Response reply(Object? value, [int status = 200]) => http.Response(
  jsonEncode(value),
  status,
  headers: {'content-type': 'application/json'},
);
Map<String, dynamic> capability({bool enabled = true}) => {
  'enabled': enabled,
  'generation': 1,
  'plannerAvailable': enabled,
  'ttlMs': 30000,
  'attemptCount': 0,
  'attemptLimit': 64,
};
Map<String, dynamic> formRecord(String command, Map view) => {
  'status': 'completed',
  'commandId': command,
  'result': {
    'kind': 'form',
    'creation': {
      'fact': 'interaction_created',
      'sessionId': view['sessionId'],
      'revision': view['revision'],
      'programDigest': view['program']['programDigest'],
      'draftRevision': 0,
      'expiresAt': view['expiresAt'],
    },
    'inputKind': 'user-text',
    'sourceTrust': 'host-supplied-metadata',
    'modelId': 'fixture-planner',
  },
};

class TextHost {
  TextHost() {
    created['sessionId'] = 'text-created';
    created['source'] = {
      'kind': 'model-proposal',
      'referenceId': 'fixture-text-source',
      'modelId': 'fixture-planner',
    };
  }
  final state = home.state(), old = temp.fixture(), created = temp.fixture();
  final calls = <http.Request>[];
  String? command;
  String mode = 'form';
  Completer<http.Response>? hold;
  Map<String, dynamic>? record;
  bool deny = false;
  late final client = MockClient((r) async {
    calls.add(r);
    final action = r.url.path.split('/').last;
    if (deny) return reply({'error': 'authentication_required'}, 401);
    if (action == 'state') return reply(state);
    if (action == 'usage') {
      return reply({
        'schema': 'real-usage-history.v1',
        'items': [],
        'sourceTrust': 'host-actions-and-client-presentation-reports',
        'minUses': 2,
        'learningSaturated': false,
      });
    }
    if (action.startsWith('usage-')) {
      return reply({'error': 'fixture_untracked'}, 400);
    }
    if (action == 'interaction-current') {
      return reply({
        'sessionId': record == null ? old['sessionId'] : created['sessionId'],
        'context': state['context'],
      });
    }
    final body = r.body.isEmpty ? null : jsonDecode(r.body);
    if (action == 'interaction-read') {
      return reply(body['sessionId'] == old['sessionId'] ? old : created);
    }
    if (action == 'textgen-state') {
      return reply(capability(enabled: mode != 'disabled'));
    }
    if (action == 'textgen-generate') {
      command = body['commandId'];
      created['source']['referenceId'] = textSourceReference(
        created['ownerId'],
        command!,
      );
      expect(body['text'], '我现在想那个你给我一个表单，让我做一下笔记');
      expect(body['confirmation'], 'generate-from-user-text');
      record = formRecord(command!, created);
      if (mode == 'unknown') throw http.ClientException('lost');
      if (hold != null) return hold!.future;
      if (mode == 'clarify' || mode == 'none') {
        record = {
          'status': 'completed',
          'commandId': command,
          'result': {
            'kind': mode,
            mode == 'clarify' ? 'question' : 'reason': '明确模型文字，不是说话或保存。',
            'inputKind': 'user-text',
            'sourceTrust': 'host-supplied-metadata',
            'modelId': 'fixture-planner',
          },
        };
      }
      return reply(record);
    }
    if (action == 'textgen-query') {
      expect(body['commandId'], command);
      return reply(record);
    }
    if (action == 'textgen-cancel') {
      return reply({'status': 'not_started', 'commandId': body['commandId']});
    }
    throw StateError('unexpected $action');
  });
}

void main() {
  test('Unicode scalar/16000 byte boundary and strict completed receipt', () {
    expect(validUserText('😀' * 4000), true);
    expect(validUserText('a' * 4001), false);
    expect(validUserText(' \n '), false);
    expect(validUserText(String.fromCharCode(0xd800)), false);
    expect(textGenerationState(capability()), isNotNull);
    expect(
      textSourceReference('demo-owner', 'round'),
      'textgen-2ba67eae759298b1e51d0147093f0ad669b769cf4d436cd9',
    );
    final fresh = temp.fixture();
    fresh['source'] = {
      'kind': 'model-proposal',
      'referenceId': textSourceReference(fresh['ownerId'], 'round'),
      'modelId': 'fixture-planner',
    };
    final receipt = formRecord('round', fresh);
    expect(textFormMatches(fresh, receipt, fresh['context']), true);
    fresh['source']['referenceId'] = textSourceReference(
      fresh['ownerId'],
      'other-round',
    );
    expect(textFormMatches(fresh, receipt, fresh['context']), false);
    receipt['result']['creation']['revision'] = 2;
    expect(textGenerationRecord(receipt, 'round'), isNull);

    final view = temp.fixture(), r = formRecord('round', temp.fixture());
    expect(textGenerationRecord(r, 'round'), isNotNull);
    r['result']['creation']['draftRevision'] = 0.0;
    expect(textGenerationRecord(r, 'round'), isNull);
    expect(
      textGenerationRecord({
        'commandId': 'round',
        'status': 'completed',
        'result': {'kind': 'form'},
      }, 'round'),
      isNull,
    );
    expect(
      textFormMatches(view, formRecord('round', view), view['context']),
      false,
    );
  });
  for (final mode in [
    'form',
    'unknown',
    'clarify',
    'none',
    'disabled',
    'cancel',
    'late',
    'auth',
    'context',
  ]) {
    testWidgets(
      'on-demand text $mode retains original local draft and never saves',
      (t) async {
        final host = TextHost()..mode = mode,
            controller = CreatureHomeController(),
            access = ValueNotifier(true);
        if (['cancel', 'late', 'auth'].contains(mode)) {
          host.hold = Completer<http.Response>();
        }
        await t.pumpWidget(
          MaterialApp(
            home: CreatureHome(
              controller: controller,
              client: host.client,
              enableTextInteraction: true,
              interactionAccess: access,
            ),
          ),
        );
        await home.idle(t);
        expect(find.byType(TextField), findsNothing);
        expect(
          await controller.presentInteraction(host.old['sessionId']),
          CreaturePresentationResult.shown,
        );
        await home.idle(t);
        await t.enterText(
          find.byKey(const ValueKey('interaction-subject')),
          '😀界',
        );
        final old = t
            .widget<TemporaryInteractionSheet>(
              find.byType(TemporaryInteractionSheet),
            )
            .recovery;
        await temp.tap(t, 'interaction-text-demand');
        expect(find.byType(TextInteractionSheet), findsOneWidget);
        await t.enterText(
          find.byKey(const Key('textgen-input')),
          '我现在想那个你给我一个表单，让我做一下笔记',
        );
        await home.idle(t);
        if (mode == 'disabled') {
          expect(
            t
                .widget<FilledButton>(find.byKey(const Key('textgen-submit')))
                .onPressed,
            isNull,
          );
        } else {
          await t.ensureVisible(find.byKey(const Key('textgen-submit')));
          await t.tap(find.byKey(const Key('textgen-submit')));
          await t.pump();
          await t.pump(const Duration(milliseconds: 20));
          final task = t
              .widget<TextInteractionSheet>(find.byType(TextInteractionSheet))
              .draft;
          if (mode == 'cancel') {
            await temp.tap(t, 'textgen-cancel');
            expect(task.record?['status'], 'not_started');
            expect(find.byKey(const Key('textgen-new')), findsNothing);
          }
          if (mode == 'auth') {
            access.value = false;
            await t.pump();
            access.value = true;
            await t.pump();
          }
          if (mode == 'late') {
            await temp.tap(t, 'textgen-return-draft');
          }
          if (host.hold != null) {
            host.hold!.complete(reply(host.record));
            await home.idle(t);
          }
          if (['auth', 'cancel'].contains(mode)) {
            expect(find.byKey(const Key('textgen-open')), findsNothing);
            expect(task.body?['commandId'], host.command);
          }
          if (mode == 'unknown') {
            expect(find.byKey(const Key('textgen-open')), findsNothing);
            await temp.tap(t, 'textgen-query');
          }
          if (['form', 'unknown'].contains(mode)) {
            expect(find.byType(TemporaryInteractionSheet), findsNothing);
            await temp.tap(t, 'textgen-open');
            await home.idle(t);
            expect(find.byType(TemporaryInteractionSheet), findsOneWidget);
            expect(
              t
                  .widget<TemporaryInteractionSheet>(
                    find.byType(TemporaryInteractionSheet),
                  )
                  .sessionId,
              'text-created',
            );
            expect(old.values['subject'], '😀界');
            expect(old.dirty, true);
          } else if (mode == 'context') {
            host.state['context'] = {
              'creatureId': 'companion',
              'sceneRevision': 2,
            };
            await temp.tap(t, 'textgen-open');
            expect(find.byType(TextInteractionSheet), findsOneWidget);
          }
          expect(
            host.calls
                .where((r) => r.url.path.endsWith('textgen-generate'))
                .length,
            1,
          );
        }
        expect(old.values['subject'], '😀界');
        expect(
          host.calls.where(
            (r) => [
              'interaction-edit',
              'interaction-save',
              'interaction-close',
            ].contains(r.url.path.split('/').last),
          ),
          isEmpty,
        );
        await t.pumpWidget(const SizedBox());
        access.dispose();
        host.client.close();
      },
    );
  }
}
