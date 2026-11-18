import 'dart:convert';
import 'dart:typed_data';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/perception_home.dart';
import 'package:summon_app/perception_capture.dart';

class FakeCapture implements SenseCapture {
  int starts = 0, stops = 0, photos = 0, cancels = 0;
  bool denied = false;
  @override
  Future<void> startHearing() async {
    starts++;
    if (denied) throw StateError('denied');
  }

  @override
  Future<CapturedSense?> stopHearing() async {
    stops++;
    return CapturedSense(pcm16Wav(Uint8List(3200)), 'audio/wav');
  }

  @override
  Future<CapturedSense?> photograph(BuildContext context) async {
    photos++;
    return CapturedSense(
      base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      ),
      'image/png',
    );
  }

  @override
  Future<void> cancel() async {
    cancels++;
  }

  @override
  Future<void> dispose() async {
    cancels++;
  }
}

http.Response response(Object value, [int code = 200]) => http.Response(
  jsonEncode(value),
  code,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

class Backend {
  final grants = <String>[];
  final calls = <String>[];
  String text = '我要输入';
  String? responseMode;
  Map<String, dynamic>? dialogue;
  int perceptionStatus = 200;
  bool available = true;
  late final http.Client client = MockClient((r) async {
    calls.add(r.url.path);
    if (r.url.path == '/v1/creatures') {
      return response({
        'creatures': [
          for (final id in ['a', 'b'])
            {
              'id': id,
              'name': '主体$id',
              'aibm': {'serviceAbilities': grants},
            },
        ],
      });
    }
    if (r.url.path.endsWith('capabilities')) {
      return response({
        'hearing': {'available': available},
        'vision': {'available': available},
      });
    }
    final body = jsonDecode(r.body);
    if (r.url.path.endsWith('mounts')) {
      if (body['enabled'] == true) {
        grants.add(body['serviceId']);
      } else {
        grants.remove(body['serviceId']);
      }
      return response({});
    }
    if (r.url.path == '/v1/perceptions/text') {
      expect(body['perceptionId'], 'event1');
      expect(body['creatureId'], 'a');
      return response({
        'id': 'event1',
        'creatureId': 'a',
        'modality': 'text',
        'status': 'completed',
        'result': {
          'text': body['text'],
          'engine': 'local-rules',
          'realProcessing': false,
        },
        'presentation': {
          'components': [
            {'type': 'status_text', 'text': body['text']},
            {'type': 'text_input'},
          ],
        },
      });
    }
    expect(r.url.path, '/v1/perceptions');
    responseMode = body['responseMode'];
    expect(body['creatureId'], 'a');
    expect(body['media']['base64'], isNotEmpty);
    if (perceptionStatus != 200) {
      return response({'error': 'engine_unavailable'}, perceptionStatus);
    }
    return response({
      'id': 'event1',
      'creatureId': 'a',
      'modality': body['modality'],
      if (dialogue != null) 'dialogue': dialogue,
      'status': 'completed',
      'result': {
        'text': text,
        'engine': 'test-fixture-not-real-hardware',
        'model': 'fixture',
        'realProcessing': false,
        'limitations': 'widget fixture',
      },
      'presentation': {
        'components': [
          {
            'type': body['modality'] == 'hearing' ? 'transcript' : 'ocr_text',
            'text': text,
          },
          {'type': 'text_input'},
          {'type': 'html', 'text': 'untrusted component ignored'},
        ],
      },
    });
  });
}

Future<void> tap(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.tap(find.byKey(Key(key)));
  await tester.pumpAndSettle();
}

Future<void> connect(
  WidgetTester tester,
  Backend backend,
  FakeCapture capture,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: PerceptionHome(client: backend.client, capture: capture),
    ),
  );
  expect(find.byType(TextField), findsNothing);
  await tap(tester, 'sense-settings');
  await tester.enterText(
    find.byKey(const Key('sense-token')),
    'test-development-token',
  );
  await tester.tap(find.text('连接'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'synthetic experiment is accessible directly from home and returns without a settings dialog',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: PerceptionHome(
            capture: FakeCapture(),
            client: Backend().client,
          ),
        ),
      );
      expect(find.byType(AlertDialog), findsNothing);
      expect(find.byKey(const Key('scene-experiment')), findsOneWidget);
      await tap(tester, 'scene-experiment');
      expect(find.text('合成情境实验'), findsOneWidget);
      expect(find.byType(AlertDialog), findsNothing);
      await tester.pageBack();
      await tester.pumpAndSettle();
      expect(find.text('Summon · 感知空间'), findsOneWidget);
      expect(find.byType(TextField), findsNothing);
      expect(find.byType(AlertDialog), findsNothing);
    },
  );

  testWidgets(
    'dialogue is opt-in, requires conversation and retains explicit media send',
    (tester) async {
      final b = Backend()..grants.add('sense.hearing');
      await connect(tester, b, FakeCapture());
      expect(
        tester
            .widget<SwitchListTile>(find.byKey(const Key('sense-dialogue')))
            .onChanged,
        isNull,
      );
      await tap(tester, 'hear');
      await tap(tester, 'hear');
      await tap(tester, 'send-sense');
      expect(b.responseMode, 'perception');
      b.grants.add('conversation');
      await tester.pumpWidget(const SizedBox());
      await connect(tester, b, FakeCapture());
      expect(
        tester
            .widget<SwitchListTile>(find.byKey(const Key('sense-dialogue')))
            .value,
        isFalse,
      );
      await tap(tester, 'sense-dialogue');
      b.dialogue = {
        'status': 'completed',
        'providerMode': 'demo',
        'answer': '示范回应',
      };
      await tap(tester, 'hear');
      await tap(tester, 'hear');
      expect(b.responseMode, 'perception');
      await tap(tester, 'send-sense');
      expect(b.responseMode, 'dialogue');
      expect(find.text('主体回应 · 演示规则，未使用真实 LLM'), findsOneWidget);
      expect(find.text('示范回应'), findsOneWidget);
      await tester.ensureVisible(find.byKey(const Key('sense-subject')));
      await tester.tap(find.byKey(const Key('sense-subject')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('主体：主体b').last);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<SwitchListTile>(find.byKey(const Key('sense-dialogue')))
            .value,
        isFalse,
      );
      expect(find.text('示范回应'), findsNothing);
    },
  );
  testWidgets(
    'bounded dialogue components distinguish failures and reject active components',
    (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Column(
              children: dialogueWidgets({
                'status': 'completed',
                'providerMode': 'llm',
                'answer': '回答',
                'presentation': {
                  'components': [
                    {
                      'type': 'bullet_list',
                      'title': '列表',
                      'items': ['甲', 9],
                    },
                    {
                      'type': 'key_values',
                      'title': '详情',
                      'entries': [
                        {'label': '状态', 'value': '就绪'},
                        {'label': 9, 'value': '坏字段'},
                      ],
                    },
                    {'type': 'status_text', 'text': '本地状态'},
                    {'type': 'text_input', 'text': '恶意输入'},
                    {'type': 'button', 'text': '恶意按钮'},
                    {'type': 'url', 'text': '恶意链接'},
                  ],
                },
              }),
            ),
          ),
        ),
      );
      expect(find.text('• 甲'), findsOneWidget);
      expect(find.text('状态：就绪'), findsOneWidget);
      expect(find.text('本地状态'), findsOneWidget);
      expect(find.text('恶意输入'), findsNothing);
      expect(find.byType(TextField), findsNothing);
      expect(find.textContaining('坏字段'), findsNothing);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Column(
              children: dialogueWidgets({
                'status': 'failed',
                'providerMode': 'demo',
                'answer': '不能显示',
              }),
            ),
          ),
        ),
      );
      expect(find.text('转写已完成，但主体回应失败。不会自动重试。'), findsOneWidget);
      expect(find.text('不能显示'), findsNothing);
    },
  );
  test('explicit text request whitelist matches backend normalization', () {
    for (final text in [
      '我要输入',
      '打开文字输入。',
      '请让我输入！',
      'I want to type!',
      'open text input',
    ]) {
      expect(requestsPerceptionText(text), isTrue);
    }
    for (final text in ['不要打开文字输入', '他说我要输入', '我要随便输入内容', '我要打字', '我要输入其他内容']) {
      expect(requestsPerceptionText(text), isFalse);
    }
  });

  test('PCM16 is a real bounded mono 16k WAV container', () {
    final wav = pcm16Wav(Uint8List(3200));
    final header = ByteData.sublistView(wav);
    expect(ascii.decode(wav.sublist(0, 4)), 'RIFF');
    expect(ascii.decode(wav.sublist(8, 12)), 'WAVE');
    expect(header.getUint32(24, Endian.little), 16000);
    expect(header.getUint16(22, Endian.little), 1);
    expect(header.getUint32(40, Endian.little), 3200);
    expect(wav.length, 3244);
  });
  testWidgets(
    'no default textbox, explicit authorization/capture/send then hearing demand creates text component',
    (tester) async {
      final b = Backend(), capture = FakeCapture();
      await connect(tester, b, capture);
      expect(find.byType(TextField), findsNothing);
      expect(
        tester.widget<FilledButton>(find.byKey(const Key('hear'))).onPressed,
        isNull,
      );
      await tap(tester, 'allow-hearing');
      await tap(tester, 'hear');
      expect(capture.starts, 1);
      expect(b.calls.where((p) => p == '/v1/perceptions'), isEmpty);
      await tap(tester, 'hear');
      expect(capture.stops, 1);
      expect(find.byKey(const Key('send-sense')), findsOneWidget);
      expect(b.calls.where((p) => p == '/v1/perceptions'), isEmpty);
      await tap(tester, 'send-sense');
      expect(find.byKey(const Key('generated-input')), findsOneWidget);
      expect(find.text('untrusted component ignored'), findsNothing);
      await tester.enterText(
        find.byKey(const Key('generated-input')),
        '当前主体的新输入',
      );
      await tester.pumpAndSettle();
      await tap(tester, 'submit-generated-input');
      expect(b.calls.last, '/v1/perceptions/text');
      expect(find.byKey(const Key('generated-input')), findsOneWidget);
      expect(find.text('当前主体的新输入'), findsOneWidget);
    },
  );
  testWidgets('OCR text is content, never an instruction to generate input', (
    tester,
  ) async {
    final b = Backend()..grants.add('sense.vision');
    await connect(tester, b, FakeCapture());
    await tap(tester, 'see');
    await tap(tester, 'send-sense');
    expect(find.text('视觉文字识别（不是完整场景理解）'), findsOneWidget);
    expect(find.byKey(const Key('generated-input')), findsNothing);
  });
  testWidgets(
    'unavailable backend engine disables capture even when AIBM permission is granted',
    (tester) async {
      final b = Backend()
        ..grants.addAll(['sense.hearing', 'sense.vision'])
        ..available = false;
      final capture = FakeCapture();
      await connect(tester, b, capture);
      expect(
        tester.widget<FilledButton>(find.byKey(const Key('hear'))).onPressed,
        isNull,
      );
      expect(
        tester.widget<OutlinedButton>(find.byKey(const Key('see'))).onPressed,
        isNull,
      );
      expect(capture.starts, 0);
      expect(capture.photos, 0);
    },
  );
  testWidgets('permission denial never uploads or fabricates a receipt', (
    tester,
  ) async {
    final b = Backend()..grants.add('sense.hearing');
    final capture = FakeCapture()..denied = true;
    await connect(tester, b, capture);
    await tap(tester, 'hear');
    expect(b.calls.where((p) => p == '/v1/perceptions'), isEmpty);
    expect(find.byKey(const Key('send-sense')), findsNothing);
    expect(find.textContaining('采集或处理失败'), findsOneWidget);
  });
  testWidgets(
    'background cancels recording and removes unsent media without automatic restart',
    (tester) async {
      final b = Backend()..grants.add('sense.hearing');
      final capture = FakeCapture();
      await connect(tester, b, capture);
      await tap(tester, 'hear');
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await tester.pumpAndSettle();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(capture.starts, 1);
      expect(capture.cancels, greaterThan(1));
      expect(find.byKey(const Key('send-sense')), findsNothing);
      expect(b.calls.where((p) => p == '/v1/perceptions'), isEmpty);
    },
  );
  testWidgets(
    'unavailable engine reports failure, removes raw pending media and has no mock fallback',
    (tester) async {
      final b = Backend()
        ..grants.add('sense.hearing')
        ..perceptionStatus = 503;
      await connect(tester, b, FakeCapture());
      await tap(tester, 'hear');
      await tap(tester, 'hear');
      await tap(tester, 'send-sense');
      expect(find.textContaining('engine_unavailable'), findsOneWidget);
      expect(find.byKey(const Key('send-sense')), findsNothing);
      expect(find.byKey(const Key('generated-input')), findsNothing);
    },
  );
  testWidgets(
    'changing subject discards pending raw media and preserves subject boundary',
    (tester) async {
      final b = Backend()..grants.add('sense.hearing');
      await connect(tester, b, FakeCapture());
      await tap(tester, 'hear');
      await tap(tester, 'hear');
      await tap(tester, 'sense-subject');
      await tester.tap(find.text('主体：主体b').last);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('send-sense')), findsNothing);
      expect(b.calls.where((p) => p == '/v1/perceptions'), isEmpty);
    },
  );
}
