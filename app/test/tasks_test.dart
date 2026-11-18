import 'dart:convert';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/api.dart';
import 'package:summon_app/tasks.dart';
import 'package:summon_app/subjects.dart';

http.Response reply(Object data, [int code = 200]) => http.Response(
  jsonEncode(data),
  code,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Map<String, dynamic> state({
  bool allowed = true,
  List<dynamic> tasks = const [],
  List<dynamic> results = const [],
}) => {
  'subjects': [
    {
      'id': 'a',
      'name': '主体',
      'status': 'active',
      'aibm': {
        'serviceAbilities': allowed ? ['local.report'] : [],
      },
    },
  ],
  'tasks': tasks,
  'results': results,
  'connectors': [],
};
Map<String, dynamic> task({String status = 'scheduled'}) => {
  'id': 't',
  'subjectId': 'a',
  'serviceId': 'local.report',
  'status': status,
  'dueAt': status == 'scheduled' ? 1000 : null,
  'trigger': {'kind': 'timer', 'at': 1000},
};
Future<void> launch(WidgetTester tester, http.Client client) async {
  await tester.pumpWidget(
    MaterialApp(
      home: TasksPage(
        api: SummonApi(
          endpoint: 'http://127.0.0.1:8080',
          token: 'test',
          client: client,
        ),
        subjectId: 'a',
        subjectName: '主体',
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
    'explicit relative task uses safe service, server delay and refresh displays real receipt',
    (tester) async {
      int writes = 0;
      bool complete = false;
      final client = MockClient((r) async {
        if (r.method == 'POST') {
          writes++;
          final body = jsonDecode(r.body);
          expect(body['serviceId'], 'local.report');
          expect(body['trigger'], {'kind': 'timer', 'delayMs': 2000});
          expect(body['requestId'], isNotEmpty);
          return reply(task());
        }
        return reply(
          state(
            tasks: writes == 0
                ? []
                : [task(status: complete ? 'completed' : 'scheduled')],
            results: complete
                ? [
                    {
                      'id': 'r',
                      'subjectId': 'a',
                      'taskId': 't',
                      'notice': '本地回执，未发消息',
                      'payload': {'purpose': 'test'},
                    },
                  ]
                : [],
          ),
        );
      });
      await launch(tester, client);
      expect(writes, 0);
      await tester.enterText(find.byKey(const Key('task-delay')), '2');
      await tap(tester, 'schedule-task');
      expect(writes, 1);
      complete = true;
      await tap(tester, 'refresh-tasks');
      expect(find.byKey(const Key('result-r')), findsOneWidget);
      expect(writes, 1);
      expect(find.byKey(const Key('cancel-t')), findsNothing);
    },
  );
  testWidgets(
    'lost scheduling response reuses ID and delay intent rather than extending deadline',
    (tester) async {
      final bodies = <Map<String, dynamic>>[];
      final client = MockClient((r) async {
        if (r.method == 'GET') {
          return reply(state(tasks: bodies.isEmpty ? [] : [task()]));
        }
        bodies.add(Map<String, dynamic>.from(jsonDecode(r.body)));
        if (bodies.length == 1) throw http.ClientException('lost response');
        return reply({...task(), 'replayed': true});
      });
      await launch(tester, client);
      await tap(tester, 'schedule-task');
      expect(
        tester
            .widget<FilledButton>(find.byKey(const Key('schedule-task')))
            .onPressed,
        isNull,
      );
      await tap(tester, 'refresh-tasks');
      await tap(tester, 'schedule-task');
      expect(bodies.length, 2);
      expect(bodies[0], bodies[1]);
      expect(find.textContaining('已确认此前安排'), findsOneWidget);
    },
  );
  testWidgets(
    'cancel is explicit and cancelled state is reconciled; revocation disables new tasks',
    (tester) async {
      int cancels = 0;
      bool allowed = true;
      final client = MockClient((r) async {
        if (r.method == 'POST') {
          expect(r.url.path, '/v1/kernel/cancellations');
          cancels++;
          return reply({});
        }
        return reply(
          state(
            allowed: allowed,
            tasks: [task(status: cancels == 0 ? 'scheduled' : 'cancelled')],
          ),
        );
      });
      await launch(tester, client);
      await tap(tester, 'cancel-t');
      await tester.tap(find.text('保留任务'));
      await tester.pumpAndSettle();
      expect(cancels, 0);
      await tap(tester, 'cancel-t');
      await tester.tap(find.text('确认取消'));
      await tester.pumpAndSettle();
      expect(cancels, 1);
      allowed = false;
      await tap(tester, 'refresh-tasks');
      expect(
        tester
            .widget<FilledButton>(find.byKey(const Key('schedule-task')))
            .onPressed,
        isNull,
      );
    },
  );
  testWidgets(
    'invalid delay disabled; event waits for future simulation and filters another subject',
    (tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final client = MockClient((r) async {
        if (r.method == 'POST') {
          expect(jsonDecode(r.body)['trigger'], {
            'kind': 'event',
            'type': 'connector.lost',
          });
          return reply(task());
        }
        return reply(
          state(
            tasks: [
              {...task(), 'id': 'foreign', 'subjectId': 'b'},
            ],
          ),
        );
      });
      await launch(tester, client);
      expect(find.byKey(const Key('cancel-foreign')), findsNothing);
      await tester.enterText(find.byKey(const Key('task-delay')), '0');
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<FilledButton>(find.byKey(const Key('schedule-task')))
            .onPressed,
        isNull,
      );
      await tester.ensureVisible(find.byKey(const Key('task-trigger')));
      await tester.tap(find.byKey(const Key('task-trigger')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('等待一次模拟连接失联').last);
      await tester.pumpAndSettle();
      expect(find.textContaining('可能一直等待'), findsOneWidget);
      await tap(tester, 'schedule-task');
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'large valid backend deadline remains viewable without a DateTime crash',
    (tester) async {
      await launch(
        tester,
        MockClient(
          (_) async => reply(
            state(
              tasks: [
                {
                  ...task(),
                  'dueAt': 9007199254740991,
                  'trigger': {'kind': 'timer', 'at': 9007199254740991},
                },
              ],
            ),
          ),
        ),
      );
      expect(find.textContaining('超出时间显示范围'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
  testWidgets(
    'periodic task shows recurrence and next dueAt, not obsolete trigger.at',
    (tester) async {
      await launch(
        tester,
        MockClient(
          (_) async => reply(
            state(
              tasks: [
                {
                  ...task(),
                  'dueAt': 2000,
                  'trigger': {'kind': 'timer', 'at': 1000, 'intervalMs': 60000},
                },
              ],
            ),
          ),
        ),
      );
      expect(find.textContaining('周期定时：每 60.0 秒'), findsOneWidget);
      expect(find.textContaining('1970-01-01T00:00:02.000Z'), findsOneWidget);
      expect(find.textContaining('1970-01-01T00:00:01.000Z'), findsNothing);
    },
  );
  testWidgets(
    'subject assembly opens task view without creating or executing anything',
    (tester) async {
      final client = MockClient((r) async {
        expect(r.method, 'GET');
        return reply(state());
      });
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
      await tap(tester, 'manage-tasks');
      expect(find.byKey(const Key('schedule-task')), findsOneWidget);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('manage-tasks')), findsOneWidget);
    },
  );
}
