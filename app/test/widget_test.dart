import 'dart:async';
import 'dart:convert';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/main.dart';

Map<String, dynamic> creature(String id, {bool talk = true}) => {
      'id': id,
      'name': id == 'a' ? '同行者' : '餐馆替身',
      'aibm': {
        'serviceAbilities': talk
            ? ['conversation', 'capabilities.describe']
            : ['capabilities.describe'],
        'activitySpace': {
          'zones': ['demo-world']
        }
      }
    };
http.Response jsonResponse(Object data, [int status = 200]) =>
    http.Response(jsonEncode(data), status,
        headers: {'content-type': 'application/json; charset=utf-8'});
Future<void> connect(WidgetTester tester, http.Client client) async {
  await tester.pumpWidget(MaterialApp(home: SummonHome(client: client)));
  await tester.enterText(find.byKey(const Key('token')), 'local-test-token');
  await tester.tap(find.text('连接'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('connect select discover send and retain demo notice',
      (tester) async {
    final calls = <String>[];
    final client = MockClient((r) async {
      calls.add(r.url.path);
      if (r.url.path.endsWith('creatures')) {
        return jsonResponse({
          'creatures': [creature('a')],
          'mode': 'demo'
        });
      }
      if (r.url.path.endsWith('sessions')) {
        return jsonResponse({'id': 's1', 'turns': []});
      }
      if (r.url.path.endsWith('plans')) {
        return jsonResponse({
          'status': 'proposed',
          'serviceId': 'capabilities.describe',
          'arguments': {}
        });
      }
      if (r.url.path.endsWith('invocations')) {
        return jsonResponse({
          'data': {
            'services': [
              {'id': 'conversation', 'title': '交流', 'effect': 'model-request'}
            ]
          }
        });
      }
      return jsonResponse({
        'turns': [
          {'role': 'user', 'content': '你好'},
          {'role': 'assistant', 'content': '【演示模式】收到'}
        ]
      });
    });
    await connect(tester, client);
    await tester.tap(find.text('同行者'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('呼叫：你能做什么'));
    await tester.pumpAndSettle();
    expect(find.text('交流'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('message')), '你好');
    await tester.tap(find.byKey(const Key('send')));
    await tester.pumpAndSettle();
    expect(calls.last, '/v1/sessions/s1/calls');
    expect(find.text('演示模式 · 未连接真实 LLM'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
  testWidgets('no conversation capability and disconnect clears old state',
      (tester) async {
    final client = MockClient((r) async => r.url.path.endsWith('creatures')
        ? jsonResponse({
            'creatures': [creature('b', talk: false)],
            'mode': 'demo'
          })
        : jsonResponse({'id': 's2'}));
    await connect(tester, client);
    await tester.tap(find.text('餐馆替身'));
    await tester.pumpAndSettle();
    expect(tester.widget<IconButton>(find.byKey(const Key('send'))).onPressed,
        isNull);
    await tester.tap(find.text('断开'));
    await tester.pumpAndSettle();
    expect(find.text('餐馆替身'), findsNothing);
    expect(find.byKey(const Key('token')), findsOneWidget);
    expect(tester.widget<TextField>(find.byKey(const Key('message'))).enabled,
        isFalse);
  });
  testWidgets('failed send preserves input and permits retry', (tester) async {
    final client = MockClient((r) async {
      if (r.url.path.endsWith('creatures')) {
        return jsonResponse({
          'creatures': [creature('a')],
          'mode': 'demo'
        });
      }
      if (r.url.path.endsWith('sessions')) return jsonResponse({'id': 's1'});
      return jsonResponse({'error': 'provider_unavailable'}, 502);
    });
    await connect(tester, client);
    await tester.tap(find.text('同行者'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('message')), '保留我');
    await tester.tap(find.byKey(const Key('send')));
    await tester.pumpAndSettle();
    expect(find.text('保留我'), findsOneWidget);
    expect(tester.widget<IconButton>(find.byKey(const Key('send'))).onPressed,
        isNotNull);
  });
  testWidgets(
      'pending connection prevents duplicate requests and safe disposal',
      (tester) async {
    final pending = Completer<http.Response>();
    int calls = 0;
    final client = MockClient((r) {
      calls++;
      return pending.future;
    });
    await tester.pumpWidget(MaterialApp(home: SummonHome(client: client)));
    await tester.enterText(find.byKey(const Key('token')), 'test');
    await tester.tap(find.text('连接'));
    await tester.pump();
    await tester.tap(find.text('连接'));
    await tester.pump();
    expect(calls, 1);
    await tester.pumpWidget(const SizedBox());
    pending.complete(jsonResponse({'creatures': [], 'mode': 'demo'}));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
  testWidgets('small mobile viewport does not overflow', (tester) async {
    tester.view.physicalSize = const Size(320, 568);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(
        home: SummonHome(client: MockClient((_) async => jsonResponse({})))));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
