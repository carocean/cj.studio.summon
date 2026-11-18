import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:material_ui/material_ui.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/creature_workbench.dart';
import 'package:summon_app/standin_avatar.dart';
import 'package:summon_app/main.dart' show SummonApp;
import 'package:summon_app/scene_experiment.dart';

import 'scene_experiment_test.dart' show Lab;
import 'perception_test.dart' show FakeCapture;

Future<void> idle(WidgetTester t) async {
  for (var i = 0; i < 8; i++) {
    await t.pump(const Duration(milliseconds: 60));
  }
}

void pureHome() {
  expect(find.byType(StandInAvatar), findsOneWidget);
  expect(find.byType(AppBar), findsNothing);
  expect(find.byType(TextField), findsNothing);
  expect(find.byType(Text), findsNothing);
  expect(find.byType(IconButton), findsNothing);
  expect(find.byType(FilledButton), findsNothing);
  expect(find.byType(TextButton), findsNothing);
  expect(find.byType(OutlinedButton), findsNothing);
  expect(find.byType(GestureDetector), findsNothing);
  expect(find.byType(InkWell), findsNothing);
}

http.Response response(Object state) => http.Response(
  jsonEncode(state),
  200,
  headers: {'content-type': 'application/json; charset=utf-8'},
);
Map<String, dynamic> state() => {
  ...Lab().state,
  'context': {'creatureId': 'companion', 'sceneRevision': 1},
};
void main() {
  testWidgets(
    'actual main entry has only a non-interactive human stand-in; only read-only usage discovery; no automatic capture',
    (t) async {
      var calls = 0, captures = 0;
      final client = MockClient((r) async {
        calls++;
        expect(r.method, 'GET');
        expect(r.url.path, '/scene/usage');
        return response({
          'schema': 'real-usage-history.v1',
          'items': [],
          'learningSaturated': false,
          'minUses': 2,
          'sourceTrust': 'host-actions-and-client-presentation-reports',
        });
      });
      await t.pumpWidget(SummonApp(client: client));
      await idle(t);
      pureHome();
      expect(find.byType(CreatureWorkbench), findsNothing);
      expect(calls, 1);
      await t.pumpWidget(
        MaterialApp(
          home: CreatureHome(
            client: client,
            senseCaptureFactory: () {
              captures++;
              return FakeCapture();
            },
          ),
        ),
      );
      await idle(t);
      await t.tapAt(const Offset(400, 250));
      await t.tapAt(const Offset(350, 280));
      await idle(t);
      pureHome();
      expect(calls, 2);
      expect(captures, 0);
      final semantics = t.ensureSemantics();
      expect(find.bySemanticsLabel(RegExp('听觉关闭，视觉关闭')), findsOneWidget);
      semantics.dispose();
    },
  );
  testWidgets(
    'stand-in motion respects reduced motion and foreground lifecycle',
    (t) async {
      StandInPainter paint() =>
          t.widget<CustomPaint>(find.byKey(const Key('standin-paint'))).painter!
              as StandInPainter;
      await t.pumpWidget(const MaterialApp(home: CreatureHome()));
      await idle(t);
      final before = paint().phase;
      await t.pump(const Duration(milliseconds: 300));
      expect(paint().phase, isNot(before));
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      await t.pump();
      final paused = paint().phase;
      await t.pump(const Duration(seconds: 1));
      expect(paint().phase, paused);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pump();
      await t.pump(const Duration(milliseconds: 300));
      expect(paint().phase, isNot(paused));
      await t.pumpWidget(
        const MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(disableAnimations: true),
            child: CreatureHome(),
          ),
        ),
      );
      await idle(t);
      final still = paint().phase;
      await t.pump(const Duration(seconds: 1));
      expect(paint().phase, still);
      pureHome();
    },
  );
  testWidgets(
    'confirmed runtime text declaration is reused; only requested input appears; close restores stand-in',
    (t) async {
      final c = CreatureHomeController();
      final s = state();
      s['textEntry'] = {
        'schema': 'scene-text-entry.v1',
        'context': s['context'],
        'maxLength': 200,
        'source': 'deterministic-policy',
      };
      final calls = <String>[];
      final client = MockClient((r) async {
        calls.add('${r.method} ${r.url.path}');
        return response(s);
      });
      await t.pumpWidget(
        MaterialApp(
          home: CreatureHome(controller: c, client: client),
        ),
      );
      await idle(t);
      pureHome();
      expect(
        await c.present(
          CreatureIntent.textInput,
          expectedContext: Map<String, dynamic>.from(s['context']),
        ),
        CreaturePresentationResult.shown,
      );
      await t.pumpAndSettle();
      expect(find.byKey(const Key('scene-text-input')), findsOneWidget);
      expect(calls, ['GET /scene/usage', 'GET /scene/state']);
      await t.enterText(find.byType(TextField), '临时文字');
      await t.tap(find.byKey(const Key('generated-close')));
      await idle(t);
      pureHome();
    },
  );
  testWidgets(
    'controller presents existing validated business panel, not a fixed dashboard or business execution',
    (t) async {
      final lab = Lab();
      await SceneExperimentApi(lab.client).request('perceive', {
        'modality': 'hearing',
        'signal': 'account-request',
      });
      lab.state['context'] = {'creatureId': 'work', 'sceneRevision': 1};
      final priorWrites = lab.writes;
      final c = CreatureHomeController();
      await t.pumpWidget(
        MaterialApp(
          home: CreatureHome(controller: c, client: lab.client),
        ),
      );
      await idle(t);
      expect(
        await c.present(CreatureIntent.account),
        CreaturePresentationResult.shown,
      );
      await t.pumpAndSettle();
      expect(find.byType(SceneExperiment), findsOneWidget);
      expect(find.byKey(const Key('scene-save')), findsOneWidget);
      expect(find.byType(CreatureWorkbench), findsNothing);
      expect(lab.writes, priorWrites);
      c.dismiss();
      await idle(t);
      pureHome();
    },
  );
  testWidgets(
    'stale or missing authority never opens a scene; delayed request cannot restore a dismissed panel',
    (t) async {
      final c = CreatureHomeController();
      var wait = false;
      final pending = Completer<http.Response>();
      final s = state();
      final client = MockClient(
        (r) async => wait ? pending.future : response(s),
      );
      await t.pumpWidget(
        MaterialApp(
          home: CreatureHome(controller: c, client: client),
        ),
      );
      await idle(t);
      expect(
        await c.present(CreatureIntent.account),
        CreaturePresentationResult.blocked,
      );
      pureHome();
      expect(
        await c.present(
          CreatureIntent.textInput,
          expectedContext: {'creatureId': 'work', 'sceneRevision': 1},
        ),
        CreaturePresentationResult.stale,
      );
      pureHome();
      wait = true;
      final result = c.present(CreatureIntent.market);
      c.dismiss();
      pending.complete(response(s));
      expect(await result, CreaturePresentationResult.stale);
      await idle(t);
      pureHome();
    },
  );
  testWidgets('render actual default Home for review, with no added overlay', (
    t,
  ) async {
    t.view.physicalSize = const Size(393, 852);
    t.view.devicePixelRatio = 1;
    addTearDown(t.view.resetPhysicalSize);
    addTearDown(t.view.resetDevicePixelRatio);
    final key = GlobalKey();
    await t.pumpWidget(RepaintBoundary(key: key, child: const SummonApp()));
    await idle(t);
    pureHome();
    expect(t.takeException(), null);
    final path = Platform.environment['SUMMON_HOME_SCREENSHOT'];
    if (path != null) {
      final boundary =
          key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      await t.runAsync(() async {
        final image = await boundary.toImage(pixelRatio: 2);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        // Synchronous local output avoids leaving file-completion futures in the
        // fake widget-test clock. No remote data or generated bitmap is involved.
        File(path).parent.createSync(recursive: true);
        File(path).writeAsBytesSync(data!.buffer.asUint8List());
        image.dispose();
      });
    }
    await t.pumpWidget(const SizedBox());
    await t.pump();
  });
}
