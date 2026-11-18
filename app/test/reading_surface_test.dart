import 'dart:convert';
import 'dart:io';

import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/reading_contract.dart';
import 'package:summon_app/reading_surface.dart';

Map<String, dynamic> copy(dynamic v) =>
    jsonDecode(jsonEncode(v)) as Map<String, dynamic>;
final fixtures = jsonDecode(
  File('test/fixtures/reading_vectors.json').readAsStringSync(),
) as Map<String, dynamic>;
final vectors = fixtures['vectors'] as List;
Widget app(Map v) => MaterialApp(
  home: ReadingSurface(
    resource: copy(v['resource']),
    readingState: copy(v['state']),
    fontCapabilities: copy(v['capabilities']),
  ),
);
int offset(Map v) {
  var n = 0;
  for (final b in v['resource']['blocks']) {
    if (b['id'] == v['state']['anchor']['blockId']) {
      return n +
          readingScalarToUtf16(b['text'], v['state']['anchor']['scalarOffset']);
    }
    n += (b['text'] as String).length + 2;
  }
  throw StateError('anchor');
}

void visible(WidgetTester t, Map v) {
  final p = t.renderObject<RenderParagraph>(
    find.byKey(const Key('reading-text')),
  );
  final caret = p.getOffsetForCaret(TextPosition(offset: offset(v)), Rect.zero);
  final point = p.localToGlobal(caret);
  final viewport = t.getRect(find.byKey(const Key('reading-viewport')));
  expect(point.dy, greaterThanOrEqualTo(viewport.top - 1));
  expect(point.dy, lessThan(viewport.bottom));
}

class NoBusinessHttp extends HttpOverrides {
  int requests = 0;
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    requests++;
    throw StateError('reading widget has no business transport');
  }
}

void main() {
  setUpAll(() async {
    final font = FontLoader('SummonPreviewSC')
      ..addFont(
        File('assets/fonts/NotoSansCJKsc-Regular.extracted.otf')
            .readAsBytes()
            .then((v) => ByteData.sublistView(v)),
      );
    await font.load();
  });
  test('actual Node C1 resource/state and UTF16 vectors; immutable defensive snapshots', () {
    for (final v in vectors) {
      final r = validatedReadingResource(v['resource']);
      expect(r, isNotNull);
      expect(validatedReadingState(r, v['state']), isNotNull);
      expect(
        readingFontAvailable(v['state']['presentation'], v['capabilities']),
        true,
      );
      expect(() => r!['blocks'][0]['text'] = 'bad', throwsUnsupportedError);
    }
    expect(validatedReadingResource(fixtures['maximumResource']), isNotNull);
    for (final m in fixtures['mappings']) {
      expect(
        readingScalarToUtf16(fixtures['unicode'], m['scalarOffset']),
        m['utf16Offset'],
      );
    }
    expect(readingScalarToUtf16('e\u0301', 1), 1);
    expect(() => readingScalarToUtf16('\ud800', 0), throwsFormatException);
  });
  test('closed data shapes, malicious source, invalid ranges and content replacement reject', () {
    final v = copy(vectors[0]), r = v['resource'], s = v['state'];
    for (final key in ['url', 'onTap', 'ownerId', 'pageIndex']) {
      expect(
        validatedReadingResource({...r, key: 'https://bad.invalid'}),
        isNull,
      );
      expect(validatedReadingState(r, {...s, key: 0}), isNull);
    }
    final bad = copy(r);
    bad['blocks'][0]['text'] = 'tampered';
    expect(validatedReadingResource(bad), isNull);
    final malformed = copy(r);
    malformed['blocks'][0]['text'] = '\udfff';
    expect(validatedReadingResource(malformed), isNull);
    expect(validatedReadingState(vectors[1]['resource'], s), isNull);
    for (final revision in [0, -1, 1.0, 9007199254740992]) {
      expect(validatedReadingState(r, {...s, 'revision': revision}), isNull);
    }
    for (final scalarOffset in [-1, 1.0, 9000]) {
      expect(
        validatedReadingState(r, {
          ...s,
          'anchor': {'blockId': 'second', 'scalarOffset': scalarOffset},
        }),
        isNull,
      );
    }
    final unsupported = copy(s);
    unsupported['presentation']['fontRef'] = 'UnverifiedLishu';
    expect(validatedReadingState(r, unsupported), isNotNull);
    expect(
      readingFontAvailable(unsupported['presentation'], v['capabilities']),
      false,
    );
    final css = copy(s);
    css['presentation']['background'] = 'url(https://bad.invalid)';
    expect(validatedReadingState(r, css), isNull);
    expect(
      readingFontAvailable(s['presentation'], {
        'installedFontIds': ['SummonPreviewSC', 'SummonPreviewSC'],
      }),
      false,
    );
  });
  for (var index = 0; index < 2; index++) {
    testWidgets(
      'real text layout preserves external anchor across viewport and style document $index',
      (t) async {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = const Size(320, 650);
        addTearDown(t.view.resetDevicePixelRatio);
        addTearDown(t.view.resetPhysicalSize);
        final v = copy(vectors[index]),
            original = jsonEncode(v),
            a = copy(v['state']['anchor']);
        await t.pumpWidget(app(v));
        await t.pumpAndSettle();
        visible(t, v);
        final element = find.byType(ReadingSurface).evaluate().single;
        t.view.physicalSize = const Size(700, 500);
        await t.pumpAndSettle();
        visible(t, v);
        final next = copy(v);
        next['state']['revision']++;
        next['state']['presentation']['background'] = '#ffc0cb';
        next['state']['presentation']['textScalePermille'] = 1800;
        await t.pumpWidget(app(next));
        await t.pumpAndSettle();
        visible(t, next);
        expect(find.byType(ReadingSurface).evaluate().single, same(element));
        expect(next['state']['anchor'], a);
        expect(jsonEncode(v), original);
        expect(find.byType(TextField), findsNothing);
        expect(find.byType(FilledButton), findsNothing);
      },
    );
  }
  testWidgets(
    'combining internal scalar anchor remains exact; unsupported presentation never substitutes',
    (t) async {
      final v = copy(vectors[3]);
      await t.pumpWidget(app(v));
      await t.pumpAndSettle();
      visible(t, v);
      expect(v['state']['anchor']['scalarOffset'], 3);
      for (final changes in [
        {'fontRef': 'UnverifiedLishu'},
        {'flow': 'paged'},
        {'pageControls': true},
      ]) {
        final next = copy(v);
        next['state']['presentation'].addAll(changes);
        next['state']['revision']++;
        await t.pumpWidget(app(next));
        await t.pumpAndSettle();
        expect(find.byKey(const Key('reading-unsupported')), findsOneWidget);
        expect(find.byKey(const Key('reading-text')), findsNothing);
        expect(next['state']['anchor'], v['state']['anchor']);
      }
    },
  );
  testWidgets(
    'new resource or invalid state retires late positioning; hide and return revalidates supplied anchor',
    (t) async {
      final first = copy(vectors[0]), second = copy(vectors[1]);
      await t.pumpWidget(app(first));
      await t.pumpWidget(app(second));
      await t.pumpAndSettle();
      visible(t, second);
      final nav = t.state<NavigatorState>(find.byType(Navigator));
      nav.push(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('另一个明确任务')),
        ),
      );
      await t.pumpAndSettle();
      nav.pop();
      await t.pumpAndSettle();
      visible(t, second);
      final invalid = copy(second);
      invalid['state']['contentDigest'] = first['resource']['contentDigest'];
      await t.pumpWidget(app(invalid));
      await t.pumpAndSettle();
      expect(find.byKey(const Key('reading-text')), findsNothing);
      expect(find.byKey(const Key('reading-unsupported')), findsOneWidget);
      await t.pumpWidget(app(second));
      await t.pumpAndSettle();
      visible(t, second);
    },
  );
  testWidgets(
    'literal source never creates actions; component issues no business HTTP',
    (t) async {
      final guard = NoBusinessHttp(), previous = HttpOverrides.current;
      HttpOverrides.global = guard;
      try {
        final v = copy(vectors[2]);
        await t.pumpWidget(app(v));
        await t.pumpAndSettle();
        final span =
            t.widget<RichText>(find.byKey(const Key('reading-text'))).text
                as TextSpan;
        expect(span.toPlainText(), v['resource']['blocks'][0]['text']);
        expect(span.recognizer, isNull);
        expect(span.children, isNull);
        expect(guard.requests, 0);
        expect(find.byType(TextField), findsNothing);
      } finally {
        HttpOverrides.global = previous;
      }
    },
  );
  testWidgets(
    'paused replacement and short large-text viewport retain supplied anchor without overflow',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(320, 360);
      t.platformDispatcher.textScaleFactorTestValue = 1.5;
      addTearDown(t.view.resetDevicePixelRatio);
      addTearDown(t.view.resetPhysicalSize);
      addTearDown(t.platformDispatcher.clearTextScaleFactorTestValue);
      final first = copy(vectors[0]), second = copy(vectors[1]);
      await t.pumpWidget(app(first));
      await t.pumpAndSettle();
      visible(t, first);
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await t.pump();
      await t.pumpWidget(app(second));
      await t.pump();
      t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await t.pumpAndSettle();
      visible(t, second);
      expect(t.takeException(), isNull);
    },
  );
}
