import 'dart:async';
import 'dart:convert';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/api.dart';
import 'package:summon_app/subjects.dart';

http.Response reply(Object value, [int code = 200]) => http.Response(
  jsonEncode(value),
  code,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Map<String, dynamic> subject({
  String status = 'active',
  List<String> services = const [],
}) => {
  'id': 'new',
  'name': '新主体',
  'status': status,
  'aibm': {'serviceAbilities': services},
};
Future<void> launch(WidgetTester tester, http.Client client) async {
  await tester.pumpWidget(
    MaterialApp(
      home: SubjectsPage(
        api: SummonApi(
          endpoint: 'http://127.0.0.1:8080',
          token: 'test',
          client: client,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> tap(WidgetTester tester, String key) async {
  await tester.pump();
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.tap(find.byKey(Key(key)));
  await tester.pump(const Duration(milliseconds: 300));
  if (find.byType(AlertDialog).evaluate().isEmpty) await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'create empty persistent subject then explicitly mount, pause and resume without execution',
    (tester) async {
      final subjects = <Map<String, dynamic>>[];
      final writes = <String>[];
      final client = MockClient((r) async {
        if (r.method == 'GET') return reply({'subjects': subjects});
        writes.add(r.url.path);
        final body = jsonDecode(r.body);
        if (r.url.path.endsWith('subjects')) {
          expect(body['name'], '新主体');
          subjects.add(subject());
        }
        if (r.url.path.endsWith('mounts')) {
          expect(body['serviceId'], 'capabilities.describe');
          expect(body['enabled'], true);
          subjects.first['aibm']['serviceAbilities'] = [
            'capabilities.describe',
          ];
        }
        if (r.url.path.endsWith('transitions')) {
          subjects.first['status'] = body['status'];
        }
        return reply(subjects.first);
      });
      await launch(tester, client);
      await tester.enterText(find.byKey(const Key('subject-name')), '新主体');
      await tap(tester, 'create-subject');
      expect(writes, ['/v1/kernel/subjects']);
      expect(find.text('状态：active · 挂载：无'), findsOneWidget);
      await tap(tester, 'mount-capabilities.describe');
      await tap(tester, 'toggle-lifecycle');
      expect(find.text('恢复主体'), findsOneWidget);
      await tap(tester, 'toggle-lifecycle');
      expect(find.text('暂停主体'), findsOneWidget);
      expect(writes.where((p) => p.endsWith('mounts')).length, 1);
      expect(
        writes.any((p) => p.contains('sessions') || p.contains('invocations')),
        false,
      );
    },
  );
  testWidgets(
    'revoking service requires confirmation and cancel does not write',
    (tester) async {
      var s = subject(services: ['local.report']);
      int writes = 0;
      final client = MockClient((r) async {
        if (r.method == 'POST') {
          writes++;
          expect(jsonDecode(r.body)['enabled'], false);
          s = subject();
        }
        return reply({
          'subjects': [s],
        });
      });
      await launch(tester, client);
      await tap(tester, 'mount-local.report');
      expect(find.textContaining('相关未完成任务会被取消'), findsOneWidget);
      await tester.tap(find.text('保留'));
      await tester.pumpAndSettle();
      expect(writes, 0);
      await tap(tester, 'mount-local.report');
      await tester.tap(find.text('撤销'));
      await tester.pumpAndSettle();
      expect(writes, 1);
      expect(
        tester
            .widget<SwitchListTile>(find.byKey(const Key('mount-local.report')))
            .value,
        false,
      );
    },
  );
  testWidgets('failed mutation gates all writes until explicit state refresh', (
    tester,
  ) async {
    int writes = 0;
    final client = MockClient((r) async {
      if (r.method == 'POST') {
        writes++;
        return reply({'error': 'transport_uncertain'}, 502);
      }
      return reply({
        'subjects': [subject()],
      });
    });
    await launch(tester, client);
    await tester.enterText(find.byKey(const Key('subject-name')), '新主体');
    await tap(tester, 'create-subject');
    expect(writes, 1);
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('create-subject')))
          .onPressed,
      isNull,
    );
    expect(
      tester
          .widget<SwitchListTile>(find.byKey(const Key('mount-local.report')))
          .onChanged,
      isNull,
    );
    await tap(tester, 'refresh-subjects');
    expect(
      tester
          .widget<FilledButton>(find.byKey(const Key('create-subject')))
          .onPressed,
      isNotNull,
    );
    expect(find.text('新主体'), findsWidgets);
  });
  testWidgets(
    'retired subject is read-only and small viewport has no overflow',
    (tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await launch(
        tester,
        MockClient(
          (_) async => reply({
            'subjects': [subject(status: 'retired')],
          }),
        ),
      );
      expect(find.byKey(const Key('toggle-lifecycle')), findsNothing);
      expect(
        tester
            .widget<SwitchListTile>(find.byKey(const Key('mount-local.report')))
            .onChanged,
        isNull,
      );
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'lost create response reuses the same request ID after reconciliation',
    (tester) async {
      final ids = <String>[];
      final saved = <String, Map<String, dynamic>>{};
      final client = MockClient((r) async {
        if (r.method == 'GET') {
          return reply({'subjects': saved.values.toList()});
        }
        final body = jsonDecode(r.body);
        final id = body['requestId'] as String;
        expect(RegExp(r'^[a-f0-9]{32}$').hasMatch(id), true);
        ids.add(id);
        saved.putIfAbsent(id, () => subject());
        if (ids.length == 1) {
          throw http.ClientException('simulated lost response');
        }
        return reply({...saved[id]!, 'replayed': true});
      });
      await launch(tester, client);
      await tester.enterText(find.byKey(const Key('subject-name')), '新主体');
      await tap(tester, 'create-subject');
      expect(saved.length, 1);
      await tap(tester, 'refresh-subjects');
      await tap(tester, 'create-subject');
      expect(ids.length, 2);
      expect(ids[0], ids[1]);
      expect(saved.length, 1);
      expect(find.text('已确认此前的创建请求。当前状态以刷新结果为准。'), findsOneWidget);
    },
  );
  testWidgets('initial loading can be dismissed without late state updates', (
    tester,
  ) async {
    final pending = Completer<http.Response>();
    await tester.pumpWidget(
      MaterialApp(
        home: SubjectsPage(
          api: SummonApi(
            endpoint: 'http://127.0.0.1:8080',
            token: 'test',
            client: MockClient((_) => pending.future),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    pending.complete(reply({'subjects': []}));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
