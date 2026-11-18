import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';

import 'creature_sense_test.dart'
    show SenseBackend, FakeVoicePlayer, mount, tap;
import 'perception_test.dart' show FakeCapture;

class StopFailureVoice extends FakeVoicePlayer {
  @override
  Future<void> stop() async {
    throw StateError('cannot_stop');
  }
}

void main() {
  testWidgets(
    'mode defaults off and each explicit end sends exactly once; no auto next round',
    (t) async {
      final b = SenseBackend()..candidate = null;
      final c = FakeCapture();
      await mount(t, b, c);
      final mode = find.byKey(const Key('bound-send-on-stop'));
      expect(t.widget<SwitchListTile>(mode).value, false);
      await tap(t, 'bound-send-on-stop');
      await tap(t, 'bound-capture');
      expect(t.widget<SwitchListTile>(mode).onChanged, isNull);
      await tap(t, 'bound-capture');
      expect(b.calls.where((v) => v.endsWith('/sense')).length, 1);
      expect(c.starts, 1);
      expect(find.byKey(const Key('bound-send')), findsNothing);
      await tap(t, 'bound-capture');
      await tap(t, 'bound-capture');
      expect(b.calls.where((v) => v.endsWith('/sense')).length, 2);
      expect(c.starts, 2);
    },
  );
  testWidgets(
    'time limit retains preview instead of sending, pending media cannot change mode',
    (t) async {
      final b = SenseBackend()..candidate = null;
      final c = FakeCapture();
      await mount(t, b, c);
      await tap(t, 'bound-send-on-stop');
      await tap(t, 'bound-capture');
      await t.pump(const Duration(seconds: 14));
      await t.pumpAndSettle();
      expect(b.calls.where((v) => v.endsWith('/sense')), isEmpty);
      expect(find.byKey(const Key('bound-send')), findsOneWidget);
      expect(
        t
            .widget<SwitchListTile>(find.byKey(const Key('bound-send-on-stop')))
            .onChanged,
        isNull,
      );
    },
  );
  testWidgets('cancel round and background stop never send; mode clears', (
    t,
  ) async {
    final b = SenseBackend();
    final c = FakeCapture();
    await mount(t, b, c);
    await tap(t, 'bound-send-on-stop');
    await tap(t, 'bound-capture');
    await tap(t, 'bound-cancel-round');
    expect(b.calls.where((v) => v.endsWith('/sense')), isEmpty);
    await tap(t, 'bound-capture');
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await t.pumpAndSettle();
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await t.pumpAndSettle();
    expect(
      t
          .widget<SwitchListTile>(find.byKey(const Key('bound-send-on-stop')))
          .value,
      false,
    );
    expect(b.calls.where((v) => v.endsWith('/sense')), isEmpty);
    expect(c.starts, 2);
  });
  testWidgets('unknown processing failure cancels mode and never resends', (
    t,
  ) async {
    final b = SenseBackend();
    final c = FakeCapture();
    await mount(t, b, c);
    await tap(t, 'bound-send-on-stop');
    await tap(t, 'bound-capture');
    b.failure = 'authorization_changed';
    await tap(t, 'bound-capture');
    expect(
      t
          .widget<SwitchListTile>(find.byKey(const Key('bound-send-on-stop')))
          .value,
      false,
    );
    expect(b.calls.where((v) => v.endsWith('/sense')).length, 1);
  });
  testWidgets('unconfirmed playback stop prevents microphone capture', (
    t,
  ) async {
    final b = SenseBackend();
    final c = FakeCapture();
    await mount(t, b, c, voicePlayer: StopFailureVoice());
    await tap(t, 'bound-send-on-stop');
    await tap(t, 'bound-capture');
    expect(c.starts, 0);
    expect(
      t
          .widget<SwitchListTile>(find.byKey(const Key('bound-send-on-stop')))
          .value,
      false,
    );
  });
}
