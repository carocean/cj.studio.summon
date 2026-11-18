import 'dart:convert';
import 'dart:io';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:summon_app/choice_form.dart';
import 'package:summon_app/focus_sheet.dart';
import 'package:summon_app/creature_workbench.dart';

import 'scene_experiment_test.dart' show Lab;
import 'creature_workbench_test.dart' as home;

class FocusBackend {
  final calls = <String>[];
  bool loseCreate = false;
  Map<String, dynamic> state = {
    'mode': 'deterministic-synthetic',
    'creatures': [],
    'primaryCreatureId': 'companion',
    'activeCreatureId': 'companion',
    'registryRevision': 1,
    'context': {'creatureId': 'companion', 'sceneRevision': 1},
    'focus': {
      'primaryCreatureId': 'companion',
      'registryRevision': 1,
      'grant': {
        'creatureId': 'companion',
        'enabled': false,
        'revision': 0,
        'generation': 0,
      },
      'activePlan': null,
      'plans': [],
      'requests': [],
    },
  };
  Map<String, dynamic>? form() {
    final f = state['focus'], g = f['grant'];
    if (g['enabled'] != true || f['activePlan'] != null) return null;
    return {
      'schema': 'choice-form.v1',
      'contractId': 'synthetic-focus.v1',
      'contractVersion': 1,
      'formId': 'form-${List.filled(64, 'c').join()}',
      'binding': {
        'context': state['context'],
        'targetCreatureId': state['primaryCreatureId'],
        'registryRevision': state['registryRevision'],
        'grantRevision': g['revision'],
        'grantGeneration': g['generation'],
        'serviceId': 'synthetic.focus.v1',
      },
      'fields': [
        for (final e in choiceContracts['synthetic-focus.v1']!.entries)
          {
            'id': e.key,
            'label': e.key,
            'type': 'choice',
            'required': true,
            'readOnly': false,
            'options': [
              for (final v in e.value) {'value': v, 'label': v},
            ],
            'value': e.value.first,
          },
      ],
    };
  }

  late final client = MockClient((req) async {
    final action = req.url.path.split('/').last;
    calls.add(action);
    final body = req.method == 'POST' ? jsonDecode(req.body) : null;
    if (action == 'focus-grant') {
      expect(body['expectedRevision'], state['focus']['grant']['revision']);
      state['focus']['grant']['enabled'] = body['enabled'];
      state['focus']['grant']['revision']++;
      state['focus']['grant']['generation']++;
    }
    if (action == 'form-focus') {
      if (loseCreate) throw Exception('lost');
      final p = plan(body['requestId'], body['values']);
      state['focus']['activePlan'] = p;
      state['focus']['plans'] = [p];
      state['focus']['requests'] = [
        {
          'requestId': body['requestId'],
          'status': 'completed',
          'planId': p['planId'],
        },
      ];
    }
    if (action == 'focus-cancel') {
      if (state['focus']['activePlan'] != null) {
        state['focus']['activePlan']['status'] = 'cancelled';
        state['focus']['activePlan'] = null;
      } else {
        state['focus']['requests'] = [
          {
            'requestId': body['requestId'],
            'status': 'cancelled',
            'planId': null,
          },
        ];
      }
    }
    if (action == 'focus-status') {
      return http.Response(
        jsonEncode({
          'requestId': body['requestId'],
          'status': 'not_started',
          'plan': null,
        }),
        200,
      );
    }
    state['choiceForms'] = {'focus': form()};
    return http.Response(jsonEncode(state), 200);
  });
}

Map<String, dynamic> plan(String id, Map input) {
  final receipt = {
    'receiptId': 'saved-one',
    'fact': 'plan_saved',
    'source': 'deterministic-synthetic-focus',
    'serviceId': 'synthetic.focus.v1',
    'serviceVersion': 1,
    'requestId': id,
    'planId': 'focus-one',
    'creatureId': 'companion',
    'input': input,
    'createdAt': 1000,
    'dueAt': 1000 + int.parse(input['duration']) * 60000,
  };
  return {
    'planId': 'focus-one',
    'requestId': id,
    'creatureId': 'companion',
    'serviceId': 'synthetic.focus.v1',
    'input': input,
    'createdAt': receipt['createdAt'],
    'dueAt': receipt['dueAt'],
    'status': 'active',
    'receipt': receipt,
  };
}

Future<void> click(WidgetTester t, String key) async {
  final f = find.byKey(Key(key));
  await t.ensureVisible(f);
  await t.tap(f);
  await t.pumpAndSettle();
}

void main() {
  testWidgets(
    'primary creature opens focus on demand without a permanent form',
    (t) async {
      final lab = Lab();
      await t.pumpWidget(
        MaterialApp(home: CreatureWorkbench(client: lab.client)),
      );
      await home.settle(t);
      expect(find.byType(FocusSheet), findsNothing);
      final entry = find.byKey(const Key('creature-focus'));
      await t.ensureVisible(entry);
      await t.tap(entry);
      await home.settle(t);
      expect(find.byType(FocusSheet), findsOneWidget);
      Navigator.of(t.element(find.byType(FocusSheet))).pop();
      await home.settle(t);
      expect(find.byType(FocusSheet), findsNothing);
    },
  );

  test('actual Node HTTP fixture validates third form and saved receipt', () {
    final f = jsonDecode(
      File('../runtime/test/fixtures/focus-http.json').readAsStringSync(),
    );
    expect(
      validatedChoiceForm(
        f['before']['choiceForms']['focus'],
        f['before'],
        'synthetic-focus.v1',
      ),
      isNotNull,
    );
    expect(validatedFocusPlan(f['after']['focus']['activePlan']), isNotNull);
    expect(validatedFocusPlan(f['status']['plan']), isNotNull);
  });

  test('third trusted policy works through unchanged general validator', () {
    final b = FocusBackend();
    b.state['focus']['grant'] = {
      'creatureId': 'companion',
      'enabled': true,
      'revision': 1,
      'generation': 1,
    };
    final raw = b.form();
    expect(validatedChoiceForm(raw, b.state, 'synthetic-focus.v1'), isNotNull);
    b.state['primaryCreatureId'] = 'other';
    expect(validatedChoiceForm(raw, b.state, 'synthetic-focus.v1'), isNull);
  });
  test('receipt fact exact matching does not claim user completion', () {
    final p = plan('q1', {'topic': 'study', 'duration': '5', 'pace': 'gentle'});
    expect(validatedFocusPlan(p), isNotNull);
    p['receipt']['fact'] = 'user_completed';
    expect(validatedFocusPlan(p), isNull);
    p['receipt']['fact'] = 'plan_saved';
    p['receipt']['creatureId'] = 'other';
    expect(validatedFocusPlan(p), isNull);
  });
  testWidgets(
    'explicit grant then common form create and readonly receipt cancellation',
    (t) async {
      final b = FocusBackend(), r = FocusRecovery();
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: FocusSheet(client: b.client, recovery: r),
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(
        t.widget<FilledButton>(find.byKey(const Key('focus-create'))).onPressed,
        isNull,
      );
      expect(b.calls.where((c) => c == 'form-focus'), isEmpty);
      await click(t, 'focus-grant');
      expect(find.byType(ChoiceForm), findsOneWidget);
      await click(t, 'focus-create');
      expect(r.requestId, isNull);
      expect(find.textContaining('计划保存回执'), findsOneWidget);
      expect(find.byKey(const Key('focus-create')), findsNothing);
      final id = b.state['focus']['activePlan']['requestId'];
      await click(t, 'focus-cancel-$id');
      expect(find.text('状态：已取消'), findsOneWidget);
      expect(b.calls.where((c) => c == 'form-focus').length, 1);
    },
  );
  testWidgets(
    'unknown closes and reopens with same request; exact query not_started never resends',
    (t) async {
      final b = FocusBackend()..loseCreate = true;
      final r = FocusRecovery();
      Future<void> show() => t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: FocusSheet(client: b.client, recovery: r),
          ),
        ),
      );
      await show();
      await t.pumpAndSettle();
      await click(t, 'focus-grant');
      await click(t, 'focus-create');
      final id = r.requestId;
      expect(id, isNotNull);
      await t.pumpWidget(const MaterialApp(home: Scaffold()));
      await show();
      await t.pumpAndSettle();
      expect(r.requestId, id);
      await click(t, 'focus-refresh');
      expect(find.textContaining('尚未开始'), findsOneWidget);
      expect(r.requestId, id);
      expect(b.calls.where((c) => c == 'form-focus').length, 1);
      await click(t, 'focus-abandon');
      expect(r.requestId, isNull);
      expect(b.calls.where((c) => c == 'form-focus').length, 1);
    },
  );
}
