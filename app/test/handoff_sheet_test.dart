import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/handoff_sheet.dart';
import 'package:summon_app/creature_workbench.dart';

final hid = 'handoff-${'a' * 48}';
final hash = 'sha256:${'b' * 64}';
const values = {
  'customerAlias': 'demo-a',
  'accountType': 'savings',
  'contactPreference': 'none',
};
Map<String, dynamic> scene() => {
  'mode': 'deterministic-synthetic',
  'creatures': [
    for (final id in ['companion', 'work'])
      {
        'id': id,
        'name': id,
        'personality': '伙伴',
        'kind': id == 'work' ? 'business' : 'companion',
        'body': id == 'work' ? 'owl' : 'sprout',
        'tone': id == 'work' ? 'precise' : 'playful',
        'senses': {'hearing': true, 'vision': true},
        'generation': 0,
      },
  ],
  'primaryCreatureId': 'companion',
  'activeCreatureId': 'companion',
  'registryRevision': 7,
  'context': {'creatureId': 'companion', 'sceneRevision': 4},
  'activity': {
    'id': 'task-1',
    'revision': 2,
    'status': 'draft',
    'form': {
      'fields': [
        for (final e in values.entries) {'id': e.key, 'value': e.value},
      ],
    },
  },
};
Map<String, dynamic> plan([String status = 'prepared']) => {
  'mode': 'deterministic-synthetic-draft-return',
  'contentReturned': false,
  'handoff': {
    'handoffId': hid,
    'status': status,
    'coordinatorId': 'companion',
    'workerId': 'work',
    'values': {...values},
    'binding': {
      'ownerId': 'demo-owner',
      'coordinatorId': 'companion',
      'workerId': 'work',
      'registryRevision': 7,
      'context': {'creatureId': 'companion', 'sceneRevision': 4},
      'activityId': 'task-1',
      'activityRevision': 2,
      'valuesDigest': hash,
    },
    'expiresAt': 300100,
    'budget': {
      'calls': 3,
      'bytes':
          3 *
          utf8
              .encode(
                jsonEncode({
                  'accountType': 'savings',
                  'contactPreference': 'none',
                  'customerAlias': 'demo-a',
                }),
              )
              .length,
    },
    'reason': null,
    'receipt': status == 'delivered'
        ? {
            'schema': 'local-artifact-delivery.v1',
            'mailId': 'mail-${'c' * 48}',
            'sender': 'agent-worker',
            'recipientId': 'agent-primary',
            'artifactId': 'ha-${'a' * 48}',
            'artifactDigest': hash,
            'contextDigest': hash,
            'purpose': 'draft-return',
            'deliveredAt': 100,
            'retentionUntil': 300100,
            'fact': 'local_recipient_copy_saved',
          }
        : null,
  },
};
Map<String, dynamic> history([String? status]) => {
  'handoffs': status == null
      ? []
      : [
          {
            'handoffId': hid,
            'status': status,
            'coordinatorId': 'companion',
            'workerId': 'work',
            'activityId': 'task-1',
            'expiresAt': 300100,
            'receipt': plan(status)['handoff']['receipt'],
          },
        ],
  'limit': 32,
  'contentReturned': false,
};
http.Response response(dynamic v) => http.Response(
  jsonEncode(v),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

class Lab {
  String? status;
  bool failConfirm = false;
  Map<String, dynamic> current = scene();
  final calls = <String>[];
  Completer<http.Response>? pending;
  late final client = MockClient((r) async {
    final a = r.url.path.split('/').last;
    calls.add(a);
    if (a == 'state') return response(current);
    if (a == 'handoff-list') return response(history(status));
    if (a == 'handoff-prepare') {
      status ??= 'prepared';
      return response(plan(status!));
    }
    expect(jsonDecode(r.body)['handoffId'], hid);
    if (a == 'handoff-confirm') {
      expect(jsonDecode(r.body)['confirmation'], 'share-synthetic-draft');
      status = 'delivered';
      if (pending != null) return pending!.future;
      if (failConfirm) throw StateError('response lost');
    }
    if (a == 'handoff-cancel' && status != 'delivered') status = 'cancelled';
    return response(plan(status!));
  });
}

Future<void> pump(WidgetTester t) async {
  await t.pump();
  await t.pump(const Duration(milliseconds: 100));
}

Future<void> click(WidgetTester t, String key) async {
  final f = find.byKey(Key(key));
  await t.ensureVisible(f);
  await t.tap(f);
  await pump(t);
}

Future<void> open(WidgetTester t, Lab l) async {
  await t.pumpWidget(
    MaterialApp(
      home: Scaffold(body: HandoffSheet(client: l.client)),
    ),
  );
  await pump(t);
}

void main() {
  test(
    'strict DTOs reject hidden body, forged receipt and invalid binding/budget',
    () {
      expect(validatedHandoff(plan()), isNotNull);
      expect(validatedHandoff(plan('delivered')), isNotNull);
      expect(validatedHandoffList(history('delivered')), isNotNull);
      final extra = plan()..['content'] = 'secret';
      expect(validatedHandoff(extra), isNull);
      final bad = plan('delivered');
      bad['handoff']['receipt']['purpose'] = 'bank-submit';
      expect(validatedHandoff(bad), isNull);
      final budget = plan();
      budget['handoff']['budget']['bytes'] = 1000000;
      expect(validatedHandoff(budget), isNull);
      final binding = plan();
      binding['handoff']['binding']['coordinatorId'] = 'other';
      expect(validatedHandoff(binding), isNull);
      final list = history('prepared');
      list['handoffs'][0]['content'] = 'hidden';
      expect(validatedHandoffList(list), isNull);
    },
  );
  testWidgets(
    'lists first, separate preview and explicit confirm, receipt not business success',
    (t) async {
      final l = Lab();
      await open(t, l);
      expect(l.calls, ['handoff-list', 'state']);
      expect(find.byType(TextField), findsNothing);
      await click(t, 'handoff-prepare');
      expect(l.calls.where((a) => a == 'handoff-confirm'), isEmpty);
      expect(find.textContaining('原草稿的输入预览'), findsOneWidget);
      await click(t, 'handoff-confirm');
      expect(l.calls.where((a) => a == 'handoff-confirm').length, 1);
      expect(find.byKey(const Key('handoff-delivered')), findsOneWidget);
      expect(find.byKey(const Key('handoff-confirm')), findsNothing);
    },
  );
  testWidgets(
    'response loss locks new preparation and recovers same ID by status without redispatch',
    (t) async {
      final l = Lab()..failConfirm = true;
      await open(t, l);
      await click(t, 'handoff-prepare');
      await click(t, 'handoff-confirm');
      expect(
        t
            .widget<OutlinedButton>(find.byKey(const Key('handoff-prepare')))
            .onPressed,
        isNull,
      );
      await click(t, 'handoff-query');
      expect(find.byKey(const Key('handoff-delivered')), findsOneWidget);
      expect(l.calls.where((a) => a == 'handoff-confirm').length, 1);
    },
  );
  testWidgets(
    'reopening recovers history and cancelled/expired plans never enable confirm',
    (t) async {
      final l = Lab()..status = 'cancelled';
      await open(t, l);
      await click(t, 'handoff-history-$hid');
      expect(find.text('状态：cancelled'), findsOneWidget);
      expect(find.byKey(const Key('handoff-confirm')), findsNothing);
      await t.pumpWidget(const SizedBox());
      l.status = 'expired';
      await open(t, l);
      await click(t, 'handoff-history-$hid');
      expect(find.text('状态：expired'), findsOneWidget);
      expect(l.calls.where((a) => a == 'handoff-prepare'), isEmpty);
    },
  );
  testWidgets(
    'cancel is explicit; changed primary before confirmation blocks dispatch',
    (t) async {
      final l = Lab();
      await open(t, l);
      await click(t, 'handoff-prepare');
      l.current['primaryCreatureId'] = 'other';
      await click(t, 'handoff-confirm');
      expect(l.calls.where((a) => a == 'handoff-confirm'), isEmpty);
      await click(t, 'handoff-cancel');
      expect(find.text('状态：cancelled'), findsOneWidget);
      expect(l.calls.where((a) => a == 'handoff-cancel').length, 1);
    },
  );
  testWidgets(
    'duplicate clicks and backgrounded late response cannot imply delivery; explicit query recovers',
    (t) async {
      final l = Lab()..pending = Completer<http.Response>();
      await open(t, l);
      await click(t, 'handoff-prepare');
      await click(t, 'handoff-confirm');
      expect(
        t
            .widget<FilledButton>(find.byKey(const Key('handoff-confirm')))
            .onPressed,
        isNull,
      );
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await pump(t);
      l.pending!.complete(response(plan('delivered')));
      await pump(t);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await pump(t);
      expect(find.byKey(const Key('handoff-delivered')), findsNothing);
      await click(t, 'handoff-query');
      expect(find.byKey(const Key('handoff-delivered')), findsOneWidget);
      expect(l.calls.where((a) => a == 'handoff-confirm').length, 1);
    },
  );
  testWidgets(
    'disposed sheet drops late response and reopened sheet uses durable list',
    (t) async {
      final l = Lab()..pending = Completer<http.Response>();
      await open(t, l);
      await click(t, 'handoff-prepare');
      await click(t, 'handoff-confirm');
      await t.pumpWidget(const SizedBox());
      l.pending!.complete(response(plan('delivered')));
      await pump(t);
      expect(t.takeException(), isNull);
      l.pending = null;
      await open(t, l);
      await click(t, 'handoff-history-$hid');
      expect(find.byKey(const Key('handoff-delivered')), findsOneWidget);
      expect(l.calls.where((a) => a == 'handoff-confirm').length, 1);
    },
  );
  testWidgets(
    'running history never auto-dispatches or creates replacement; explicit resume keeps original ID',
    (t) async {
      final l = Lab()..status = 'running';
      await open(t, l);
      expect(find.byKey(const Key('handoff-prepare')), findsNothing);
      await click(t, 'handoff-history-$hid');
      expect(find.textContaining('可能已有部分授权'), findsOneWidget);
      expect(l.calls.where((a) => a == 'handoff-confirm'), isEmpty);
      await click(t, 'handoff-confirm');
      expect(find.byKey(const Key('handoff-delivered')), findsOneWidget);
      expect(l.calls.where((a) => a == 'handoff-confirm').length, 1);
      expect(l.calls.where((a) => a == 'handoff-prepare'), isEmpty);
    },
  );
  testWidgets(
    'a newer route keeps control and stale handoff completion requires status query on return',
    (t) async {
      final l = Lab()..pending = Completer<http.Response>();
      await open(t, l);
      await click(t, 'handoff-prepare');
      await click(t, 'handoff-confirm');
      final navigator = t.state<NavigatorState>(find.byType(Navigator));
      navigator.push(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('newer-page')),
        ),
      );
      await t.pumpAndSettle();
      l.pending!.complete(response(plan('delivered')));
      await pump(t);
      expect(find.text('newer-page'), findsOneWidget);
      navigator.pop();
      await t.pumpAndSettle();
      expect(find.byKey(const Key('handoff-delivered')), findsNothing);
      expect(
        t
            .widget<FilledButton>(find.byKey(const Key('handoff-confirm')))
            .onPressed,
        isNull,
      );
      await click(t, 'handoff-query');
      expect(find.byKey(const Key('handoff-delivered')), findsOneWidget);
      expect(l.calls.where((a) => a == 'handoff-confirm').length, 1);
    },
  );
  testWidgets(
    'Home offers coordination only for complete primary draft; history remains accessible without a draft',
    (t) async {
      final l = Lab();
      l.current['activity'] = null;
      await t.pumpWidget(
        MaterialApp(home: CreatureWorkbench(client: l.client)),
      );
      await pump(t);
      expect(find.byKey(const Key('creature-handoff')), findsNothing);
      expect(find.byType(TextField), findsNothing);
      await click(t, 'creature-menu');
      await t.tap(find.text('核对生物交接历史'));
      await pump(t);
      await pump(t);
      expect(find.text('主生物协调工作伙伴'), findsOneWidget);
      expect(l.calls.where((a) => a == 'handoff-prepare'), isEmpty);
      await t.pumpWidget(const SizedBox());
      l.current = scene();
      await t.pumpWidget(
        MaterialApp(home: CreatureWorkbench(client: l.client)),
      );
      await pump(t);
      await click(t, 'creature-handoff');
      await pump(t);
      expect(find.text('主生物协调工作伙伴'), findsOneWidget);
      expect(l.calls.where((a) => a == 'handoff-prepare'), isEmpty);
    },
  );
  testWidgets(
    'failed selection of another history item never leaves old cancel controls bound to the new ID',
    (t) async {
      final second = 'handoff-${'d' * 48}';
      final client = MockClient((r) async {
        final a = r.url.path.split('/').last;
        if (a == 'state') return response(scene());
        if (a == 'handoff-list') {
          final h = history('prepared');
          h['handoffs'] = [
            ...h['handoffs'],
            <String, dynamic>{...h['handoffs'][0], 'handoffId': second},
          ];
          expect(validatedHandoffList(h), isNotNull);
          return response(h);
        }
        final id = jsonDecode(r.body)['handoffId'];
        if (id == second) throw StateError('unavailable status');
        return response(plan());
      });
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(body: HandoffSheet(client: client)),
        ),
      );
      await pump(t);
      await click(t, 'handoff-history-$hid');
      expect(find.byKey(const Key('handoff-cancel')), findsOneWidget);
      await click(t, 'handoff-history-$second');
      expect(find.byKey(const Key('handoff-cancel')), findsNothing);
      expect(find.byKey(const Key('handoff-confirm')), findsNothing);
    },
  );
}
