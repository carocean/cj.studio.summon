import 'dart:convert';
import 'dart:io';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:summon_app/choice_form.dart';

Map<String, dynamic> fixture() => jsonDecode(
  File('../runtime/test/fixtures/choice-forms.json').readAsStringSync(),
);
Map<String, dynamic> state(Map<String, dynamic> f) => {
  ...(f['input'] as Map<String, dynamic>),
  'activeCreatureId': f['input']['context']['creatureId'],
};
Map<String, dynamic> copy(Map<String, dynamic> v) => jsonDecode(jsonEncode(v));
void main() {
  test(
    'shared Node-generated declarations pass closed client binding validation',
    () {
      final f = fixture(), s = state(f);
      expect(
        validatedChoiceForm(
          f['choiceForms']['account'],
          s,
          'synthetic-account.v1',
        ),
        isNotNull,
      );
      expect(
        validatedChoiceForm(f['choiceForms']['route'], s, 'synthetic-route.v1'),
        isNotNull,
      );
    },
  );
  test('unknown code fields, foreign actor, invalid options and readonly escalation fail closed', () {
    final f = fixture(),
        s = state(f),
        original = Map<String, dynamic>.from(f['choiceForms']['account']);
    for (final mutate in <void Function(Map<String, dynamic>)>[
      (v) => v['url'] = 'https://example.invalid',
      (v) => v['binding']['context']['creatureId'] = 'other',
      (v) => v['fields'][0]['options'][0]['value'] = 'private-data',
      (v) => v['fields'][0]['options'].add(v['fields'][0]['options'][0]),
      (v) => v['fields'][0]['id'] = 'passport',
      (v) => v['fields'][0]['type'] = 'script',
    ]) {
      final v = copy(original);
      mutate(v);
      expect(validatedChoiceForm(v, s, 'synthetic-account.v1'), isNull);
    }
    s['activity']['status'] = 'completed';
    expect(validatedChoiceForm(original, s, 'synthetic-account.v1'), isNull);
    for (final field in original['fields']) {
      field['readOnly'] = true;
    }
    expect(validatedChoiceForm(original, s, 'synthetic-account.v1'), isNotNull);
    expect(validatedChoiceForm(null, s, 'synthetic-account.v1'), isNull);
    expect(
      validatedChoiceForm(original, {'market': 'broken'}, 'synthetic-route.v1'),
      isNull,
    );
  });
  test('same binding keeps dirty values, changed binding freezes until explicit reload', () {
    final f = fixture(), s = state(f);
    final raw = Map<String, dynamic>.from(f['choiceForms']['account']);
    final draft = ChoiceDraft()..reconcile(raw, s, 'synthetic-account.v1');
    draft.values['customerAlias'] = 'demo-b';
    draft.reconcile(raw, s, 'synthetic-account.v1');
    expect(draft.values['customerAlias'], 'demo-b');
    expect(draft.stale, false);
    final next = copy(raw);
    next['binding']['activityRevision']++;
    s['activity']['revision']++;
    draft.reconcile(next, s, 'synthetic-account.v1');
    expect(draft.stale, true);
    expect(draft.ready, false);
    expect(draft.values['customerAlias'], 'demo-b');
    draft.reload();
    expect(draft.stale, false);
    expect(draft.values['customerAlias'], 'demo-a');
  });
  test(
    'changed form ID with same binding freezes a compatible dirty draft',
    () {
      final f = fixture(),
          s = state(f),
          raw = Map<String, dynamic>.from(f['choiceForms']['account']);
      final d = ChoiceDraft()..reconcile(raw, s, 'synthetic-account.v1');
      d.values['customerAlias'] = 'demo-b';
      final next = copy(raw);
      next['formId'] = 'form-${List.filled(64, 'b').join()}';
      next['fields'][0]['label'] = '更新的标题';
      d.reconcile(next, s, 'synthetic-account.v1');
      expect(d.stale, true);
      expect(d.values['customerAlias'], 'demo-b');
      expect(d.ready, false);
    },
  );
  test('invalid zero, negative and unsafe revisions fail closed even if state agrees', () {
    for (final value in [0, -1, 9007199254740992]) {
      final f = fixture(),
          s = state(f),
          raw = Map<String, dynamic>.from(f['choiceForms']['account']);
      raw['binding']['context']['sceneRevision'] = value;
      s['context']['sceneRevision'] = value;
      expect(validatedChoiceForm(raw, s, 'synthetic-account.v1'), isNull);
    }
  });
  test('options removed under same binding freeze old dirty values; no silent migration', () {
    final f = fixture(),
        s = state(f),
        raw = Map<String, dynamic>.from(fixture()['choiceForms']['account']);
    final d = ChoiceDraft()..reconcile(raw, s, 'synthetic-account.v1');
    d.values['customerAlias'] = 'demo-b';
    final next = copy(raw);
    next['fields'][0]['options'] = [
      {'value': 'demo-a', 'label': 'Only A'},
    ];
    d.reconcile(next, s, 'synthetic-account.v1');
    expect(d.stale, true);
    expect(d.values['customerAlias'], 'demo-b');
    expect(d.ready, false);
  });
  testWidgets(
    'server field order and option subset render without separate business widgets',
    (t) async {
      final f = fixture(),
          s = state(f),
          raw = Map<String, dynamic>.from(fixture()['choiceForms']['route']);
      raw['fields'] = (raw['fields'] as List).reversed.toList();
      raw['fields'][0]['options'] = [
        {'value': 'C', 'label': '终点丙'},
      ];
      final d = ChoiceDraft()..reconcile(raw, s, 'synthetic-route.v1');
      await t.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ChoiceForm(draft: d, onChanged: () {}),
          ),
        ),
      );
      final fields = t
          .widgetList<DropdownButtonFormField<String>>(
            find.byType(DropdownButtonFormField<String>),
          )
          .toList();
      expect(fields.length, 2);
      expect(find.text('终点丙'), findsWidgets);
      expect(d.current!['fields'][0]['id'], 'to');
    },
  );
  testWidgets('missing contract is visibly unavailable, never falls back', (
    t,
  ) async {
    final d = ChoiceDraft()..reconcile(null, {}, 'synthetic-account.v1');
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ChoiceForm(draft: d, onChanged: () {}),
        ),
      ),
    );
    expect(find.byKey(const Key('choice-unavailable')), findsOneWidget);
    expect(find.byType(DropdownButtonFormField<String>), findsNothing);
  });
}
