import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/real_usage.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/creature_registry.dart';
import 'package:summon_app/temporary_interaction.dart';

import 'creature_home_minimal_test.dart' as home;
import 'temporary_interaction_test.dart' as temp;

Map<String, dynamic> history(List items) => {
  'schema': 'real-usage-history.v1',
  'items': items,
  'learningSaturated': false,
  'minUses': 2,
  'sourceTrust': 'host-actions-and-client-presentation-reports',
};
Map<String, dynamic> item(String kind, String id, String label) => {
  'kind': kind,
  'targetId': id,
  'label': label,
  'useCount': 2,
  'lastUsedAt': 1000,
};
Map<String, dynamic> receipt(Map body, {bool selection = false}) => {
  'replayed': false,
  'receiptStored': true,
  'ack': selection
      ? {
          'fact': 'creature_selection_confirmed',
          'creatureId': body['creatureId'],
          'changed': true,
          'context': {'creatureId': body['creatureId'], 'sceneRevision': 2},
          'usage': {'recorded': true, 'reason': 'recorded', 'useCount': 3},
        }
      : {
          'fact': 'interaction_presentation_reported',
          'sessionId': body['sessionId'],
          'revision': body['expectedRevision'],
          'programDigest': body['programDigest'],
          'usage': {'recorded': true, 'reason': 'recorded', 'useCount': 3},
        },
};
void main() {
  testWidgets('generated titles do not reach home and auth retires history', (
    t,
  ) async {
    final access = ValueNotifier<bool>(true);
    final controller = CreatureHomeController();
    final pending = Completer<http.Response>();
    final first = history([
      item('interaction-session', 'draft', 'private generated title'),
    ]);
    var reads = 0;
    final client = MockClient.streaming((r, _) async {
      expect(r.url.path.split('/').last, 'usage');
      reads++;
      final response = switch (reads) {
        1 => home.response(first),
        2 => await pending.future,
        _ => home.response(history([])),
      };
      return http.StreamedResponse(
        Stream.value(response.bodyBytes),
        response.statusCode,
      );
    });
    await t.pumpWidget(
      MaterialApp(
        home: CreatureHome(
          controller: controller,
          client: client,
          interactionAccess: access,
        ),
      ),
    );
    await home.idle(t);
    expect(find.text('临时 · 生成内容'), findsOneWidget);
    expect(find.textContaining('private generated title'), findsNothing);
    final inflight = controller.refreshUsage();
    await home.idle(t);
    expect(reads, 2);
    access.value = false;
    await home.idle(t);
    expect(find.text('临时 · 生成内容'), findsNothing);
    access.value = true;
    await home.idle(t);
    expect(reads, 3);
    pending.complete(home.response(first));
    await home.idle(t);
    await inflight;
    expect(find.text('临时 · 生成内容'), findsNothing);
    await t.pumpWidget(const SizedBox());
    access.dispose();
  });
  test(
    'history closed schema, actual threshold, no saved-note or malformed label',
    () {
      expect(validatedUsage(history([])), isNotNull);
      final good = history([item('creature', 'work', '真实选择')]);
      expect(validatedUsage(good), isNotNull);
      for (final change in <void Function(Map)>[
        (r) => r['items'][0]['useCount'] = 1,
        (r) => r['items'][0]['kind'] = 'saved-note',
        (r) => r['items'][0]['label'] = 'bad\u0000',
        (r) => r['items'][0]['label'] = '\ud800',
        (r) => r['attentionVerified'] = true,
        (r) => r['minUses'] = 2.0,
      ]) {
        final r = jsonDecode(jsonEncode(good)) as Map;
        change(r);
        expect(validatedUsage(r), isNull);
      }
    },
  );
  test('contradictory selection and saturation receipts are rejected', () {
    final body = {
      'commandId': 'round',
      'creatureId': 'work',
      'context': {'creatureId': 'companion', 'sceneRevision': 1},
    };
    expect(
      validatedUsageResult(
        receipt(body, selection: true),
        body,
        selection: true,
      ),
      isNotNull,
    );
    for (final change in <void Function(Map)>[
      (r) => r['ack']['changed'] = false,
      (r) => r['ack']['context']['sceneRevision'] = 9,
      (r) => r['ack']['usage']['reason'] = 'same-target',
      (r) => r['ack']['usage']['useCount'] = 0,
      (r) => r['receiptStored'] = false,
      (r) => r['ack']['usage'] = {
        'recorded': false,
        'reason': 'learning-saturated',
        'useCount': null,
      },
      (r) {
        r['replayed'] = true;
        r['receiptStored'] = false;
        r['ack']['usage'] = {
          'recorded': false,
          'reason': 'learning-saturated',
          'useCount': null,
        };
      },
    ]) {
      final r = jsonDecode(jsonEncode(receipt(body, selection: true))) as Map;
      change(r);
      expect(validatedUsageResult(r, body, selection: true), isNull);
    }
  });
  testWidgets(
    'registry untracked query requires state check and explicit finish before new choice',
    (t) async {
      final state = home.state(), commands = <String>[];
      final recovery = CreatureSelectionRecovery();
      final client = MockClient((r) async {
        final action = r.url.path.split('/').last;
        if (action == 'state') return home.response(state);
        final body = jsonDecode(r.body);
        if (action == 'usage-select') {
          commands.add(body['commandId']);
          throw http.ClientException('lost');
        }
        expect(action, 'usage-query');
        expect(body['commandId'], commands.single);
        return home.response({
          'status': 'untracked',
          'commandId': body['commandId'],
          'reason': 'learning-saturated',
        });
      });
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: CreatureRegistrySheet(
              client: client,
              selectionRecovery: recovery,
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      await temp.tap(t, 'registry-row-work');
      await temp.tap(t, 'registry-select');
      expect(commands.length, 1);
      await t.pumpWidget(const SizedBox());
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: CreatureRegistrySheet(
              client: client,
              selectionRecovery: recovery,
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(recovery.body?['commandId'], commands.single);
      await temp.tap(t, 'registry-selection-query');
      expect(
        find.byKey(const Key('registry-selection-finish')),
        findsOneWidget,
      );
      expect(commands.length, 1);
      await temp.tap(t, 'registry-selection-finish');
      expect(commands.length, 1);
      await temp.tap(t, 'registry-row-work');
      await temp.tap(t, 'registry-select');
      expect(commands.length, 2);
      expect(commands[0], isNot(commands[1]));
      await t.pumpWidget(const SizedBox());
      client.close();
    },
  );
  for (final mode in [
    'empty',
    'below',
    'creature',
    'unknown',
    'saturated',
    'session',
    'expired',
    'new-route',
    'active-draft',
    'hidden-dirty',
    'hidden-pending',
  ]) {
    testWidgets(
      'real-only bottom row $mode never treats history as authority',
      (t) async {
        final controller = CreatureHomeController(),
            state = home.state(),
            view = temp.fixture();
        final writes = <Map<String, dynamic>>[], queries = <String>[];
        final hold = Completer<http.Response>();
        var usage = history(
          mode == 'empty'
              ? []
              : [
                  item(
                    mode == 'creature' ||
                            mode == 'unknown' ||
                            mode == 'saturated' ||
                            mode == 'hidden-dirty' ||
                            mode == 'hidden-pending'
                        ? 'creature'
                        : 'interaction-session',
                    mode == 'creature' ||
                            mode == 'unknown' ||
                            mode == 'saturated' ||
                            mode == 'hidden-dirty' ||
                            mode == 'hidden-pending'
                        ? 'work'
                        : view['sessionId'],
                    '使用过的项目',
                  ),
                ],
        );
        if (mode == 'below') usage['items'][0]['useCount'] = 1;
        final client = MockClient((r) async {
          final action = r.url.path.split('/').last;
          if (action == 'usage') return home.response(usage);
          if (action == 'state') return home.response(state);
          if (action == 'interaction-current') {
            return home.response({
              'sessionId': view['sessionId'],
              'context': view['context'],
            });
          }
          final body = jsonDecode(r.body) as Map<String, dynamic>;
          if (action == 'interaction-read') {
            if (mode == 'expired') {
              usage = history([]);
              return http.Response(
                '{"error":"interaction_session_expired"}',
                400,
              );
            }
            if (mode == 'new-route') return hold.future;
            return home.response(view);
          }
          if (action == 'usage-query') {
            queries.add(body['commandId']);
            return home.response(
              mode == 'saturated'
                  ? {
                      'status': 'untracked',
                      'commandId': body['commandId'],
                      'reason': 'learning-saturated',
                    }
                  : {'status': 'not_started', 'commandId': body['commandId']},
            );
          }
          writes.add({'action': action, ...body});
          if (mode == 'unknown' || mode == 'saturated') {
            throw http.ClientException('unknown result');
          }
          return home.response(
            receipt(body, selection: action == 'usage-select'),
          );
        });
        await t.pumpWidget(
          MaterialApp(
            home: CreatureHome(controller: controller, client: client),
          ),
        );
        await home.idle(t);
        final buttons = find.byWidgetPredicate(
          (w) => w is TextButton && w.key.toString().contains('frequent-'),
        );
        if (mode == 'empty' || mode == 'below') {
          expect(buttons, findsNothing);
          expect(writes, isEmpty);
        } else {
          expect(buttons, findsOneWidget);
          expect(writes, isEmpty);
          if ([
            'active-draft',
            'hidden-dirty',
            'hidden-pending',
          ].contains(mode)) {
            final pending = controller.presentInteraction(view['sessionId']);
            await home.idle(t);
            expect(await pending, CreaturePresentationResult.shown);
            await home.idle(t);
            await t.enterText(
              find.byKey(const ValueKey('interaction-subject')),
              '保稿',
            );
            final retained = t
                .widget<TemporaryInteractionSheet>(
                  find.byType(TemporaryInteractionSheet),
                )
                .recovery;
            if (mode == 'hidden-pending') {
              retained.pending = {
                'operation': 'edit',
                'body': {
                  'commandId': 'original-edit',
                  'sessionId': view['sessionId'],
                  'expectedRevision': view['revision'],
                },
                'programDigest': view['program']['programDigest'],
                'draftRevision': 0,
              };
            }
            if (mode != 'active-draft') {
              controller.dismiss();
              await home.idle(t);
            }
            final button = t.widget<TextButton>(
              find.byWidgetPredicate(
                (w) =>
                    w is TextButton && w.key.toString().contains('frequent-'),
                skipOffstage: false,
              ),
            );
            button.onPressed!();
            await home.idle(t);
            expect(retained.values['subject'], '保稿');
            if (mode == 'hidden-pending') {
              expect(retained.pending!['body']['commandId'], 'original-edit');
            }
            expect(writes, isEmpty);
          } else {
            await t.tap(buttons);
            await home.idle(t);
            if (mode == 'new-route') {
              final nav = Navigator.of(t.element(find.byType(CreatureHome)));
              unawaited(
                nav.push(
                  MaterialPageRoute<void>(
                    builder: (_) => const Scaffold(body: Text('newer')),
                  ),
                ),
              );
              await home.idle(t);
              hold.complete(home.response(view));
              await home.idle(t);
              expect(find.text('newer'), findsOneWidget);
              expect(writes, isEmpty);
            } else if (mode == 'session') {
              await home.idle(t);
              expect(find.byType(TemporaryInteractionSheet), findsOneWidget);
              expect(writes.length, 1);
              expect(writes.single['action'], 'usage-presented');
              final id = writes.single['commandId'];
              await controller.refreshUsage();
              await home.idle(t);
              expect(writes.single['commandId'], id);
              expect(writes.length, 1);
            } else if (mode == 'expired') {
              expect(find.byType(TemporaryInteractionSheet), findsNothing);
              expect(writes, isEmpty);
            } else if (mode == 'unknown' || mode == 'saturated') {
              expect(writes.length, 1);
              final id = writes.single['commandId'];
              await t.tap(find.byKey(const Key('usage-query')));
              await home.idle(t);
              expect(queries, [id]);
              expect(writes.length, 1);
              if (mode == 'saturated') {
                expect(
                  find.byKey(const Key('usage-finish-unknown')),
                  findsOneWidget,
                );
                await t.tap(find.byKey(const Key('usage-finish-unknown')));
                await home.idle(t);
                expect(writes.length, 1);
                await t.tap(buttons);
                await home.idle(t);
                expect(writes.length, 2);
                expect(writes.last['commandId'], isNot(id));
              }
            } else {
              expect(writes.single['action'], 'usage-select');
              expect(writes.single.keys.toSet(), {
                'action',
                'commandId',
                'creatureId',
                'context',
              });
            }
          }
        }
        await t.pumpWidget(const SizedBox());
        client.close();
      },
    );
  }
}
