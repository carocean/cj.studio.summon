import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:summon_app/perception_capture.dart';

const camera = CameraDescription(
  name: 'test-back',
  lensDirection: CameraLensDirection.back,
  sensorOrientation: 0,
);

class DelayedCamera implements CameraSession {
  final initialization = Completer<void>();
  final picture = Completer<XFile>();
  int starts = 0, disposals = 0, takes = 0;
  @override
  Future<void> initialize() {
    starts++;
    return initialization.future;
  }

  @override
  Future<void> dispose() async {
    disposals++;
  }

  @override
  Future<XFile> takePicture() {
    takes++;
    return picture.future;
  }

  @override
  Widget preview() => const Text('camera-preview');
}

class DelayedFile extends XFile {
  DelayedFile() : super.fromData(Uint8List(0));
  final read = Completer<Uint8List>();
  int reads = 0;
  @override
  Future<Uint8List> readAsBytes() {
    reads++;
    return read.future;
  }
}

Future<void> mount(
  WidgetTester t,
  Future<List<CameraDescription>> Function() load,
  CameraSession Function(CameraDescription) factory,
) async {
  await t.pumpWidget(
    MaterialApp(
      home: CameraCapturePage(loadCameras: load, createSession: factory),
    ),
  );
  await t.pump();
}

void main() {
  testWidgets(
    'closing during enumeration never creates or initializes camera',
    (t) async {
      final enumeration = Completer<List<CameraDescription>>();
      int creates = 0;
      final cameraSession = DelayedCamera();
      await mount(t, () => enumeration.future, (_) {
        creates++;
        return cameraSession;
      });
      await t.pumpWidget(const SizedBox());
      enumeration.complete([camera]);
      await t.pumpAndSettle();
      expect(creates, 0);
      expect(cameraSession.starts, 0);
      expect(t.takeException(), isNull);
    },
  );
  testWidgets(
    'closing during initialization disposes pending camera immediately and ignores late completion',
    (t) async {
      final c = DelayedCamera();
      await mount(t, () async => [camera], (_) => c);
      expect(c.starts, 1);
      await t.pumpWidget(const SizedBox());
      expect(c.disposals, 1);
      c.initialization.complete();
      await t.pumpAndSettle();
      expect(c.disposals, 1);
      expect(c.takes, 0);
      expect(t.takeException(), isNull);
    },
  );
  for (final state in [AppLifecycleState.hidden, AppLifecycleState.paused]) {
    testWidgets('$state abandons enumeration and never auto-restarts', (
      t,
    ) async {
      final enumeration = Completer<List<CameraDescription>>();
      int creates = 0;
      await mount(t, () => enumeration.future, (_) {
        creates++;
        return DelayedCamera();
      });
      t.binding.handleAppLifecycleStateChanged(state);
      await t.pump();
      enumeration.complete([camera]);
      await t.pumpAndSettle();
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      expect(creates, 0);
      expect(find.text('相机已关闭'), findsOneWidget);
    });
  }
  testWidgets(
    'hidden disposes pending initialization; late failure cannot change closed UI',
    (t) async {
      final c = DelayedCamera();
      await mount(t, () async => [camera], (_) => c);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      await t.pump();
      expect(c.disposals, 1);
      c.initialization.completeError(StateError('late'));
      await t.pumpAndSettle();
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      expect(find.text('相机已关闭'), findsOneWidget);
      expect(find.textContaining('无法启用相机'), findsNothing);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      expect(c.starts, 1);
    },
  );
  testWidgets('hidden removes live preview and disables capture', (t) async {
    final c = DelayedCamera()..initialization.complete();
    await mount(t, () async => [camera], (_) => c);
    await t.pumpAndSettle();
    expect(find.text('camera-preview'), findsOneWidget);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await t.pumpAndSettle();
    expect(c.disposals, 1);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await t.pumpAndSettle();
    expect(find.text('camera-preview'), findsNothing);
    expect(
      t.widget<FilledButton>(find.byKey(const Key('camera-take'))).onPressed,
      isNull,
    );
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await t.pumpAndSettle();
    expect(c.starts, 1);
  });
  testWidgets('late photo after close is not read or returned', (t) async {
    final c = DelayedCamera()..initialization.complete();
    await mount(t, () async => [camera], (_) => c);
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('camera-take')));
    await t.pump();
    await t.pumpWidget(const SizedBox());
    final file = DelayedFile();
    c.picture.complete(file);
    await t.pumpAndSettle();
    expect(file.reads, 0);
    expect(c.disposals, 1);
    expect(t.takeException(), isNull);
  });
  testWidgets('closing while photo bytes are pending rejects late bytes', (
    t,
  ) async {
    final c = DelayedCamera()..initialization.complete();
    final file = DelayedFile();
    c.picture.complete(file);
    await mount(t, () async => [camera], (_) => c);
    await t.pumpAndSettle();
    await t.tap(find.byKey(const Key('camera-take')));
    await t.pump();
    expect(file.reads, 1);
    await t.pumpWidget(const SizedBox());
    file.read.complete(Uint8List.fromList([255, 216, 0, 0]));
    await t.pumpAndSettle();
    expect(c.disposals, 1);
    expect(t.takeException(), isNull);
  });
  testWidgets('route pop marks abandoned before exit transition completes', (
    t,
  ) async {
    final enumeration = Completer<List<CameraDescription>>();
    int creates = 0;
    await t.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => CameraCapturePage(
                    loadCameras: () => enumeration.future,
                    createSession: (_) {
                      creates++;
                      return DelayedCamera();
                    },
                  ),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await t.tap(find.text('open'));
    await t.pumpAndSettle();
    await t.pageBack(); // Route is still mounted during its exit animation.
    enumeration.complete([camera]);
    await t.pump();
    expect(creates, 0);
    await t.pumpAndSettle();
    expect(find.text('open'), findsOneWidget);
  });
  testWidgets(
    'late native photo is removed without popping parent route twice',
    (t) async {
      final c = DelayedCamera()..initialization.complete();
      final directory = await t.runAsync(
        () => Directory.systemTemp.createTemp('summon-camera-late-'),
      );
      final file = File('${directory!.path}/photo.jpg');
      await t.runAsync(() => file.writeAsBytes([255, 216, 0, 0]));
      await t.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => CameraCapturePage(
                      loadCameras: () async => [camera],
                      createSession: (_) => c,
                    ),
                  ),
                ),
                child: const Text('camera-parent'),
              ),
            ),
          ),
        ),
      );
      await t.tap(find.text('camera-parent'));
      await t.pumpAndSettle();
      await t.tap(find.byKey(const Key('camera-take')));
      await t.pump();
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      c.picture.complete(XFile(file.path));
      await t.pump(); // Flush the fake-async capture continuation before real file I/O.
      for (var i = 0; i < 30; i++) {
        await t.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 10)),
        );
        await t.pump();
        if (await t.runAsync(file.exists) == false) break;
      }
      expect(await t.runAsync(file.exists), isFalse);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      expect(find.text('camera-parent'), findsOneWidget);
      expect(c.disposals, 1);
      expect(t.takeException(), isNull);
      await t.runAsync(() => directory.delete(recursive: true));
    },
  );
}
