import 'dart:convert';

import 'package:material_ui/material_ui.dart';

import 'choice_contracts.dart';
export 'choice_contracts.dart' show choiceContracts;

bool _closed(dynamic value, Set<String> keys) =>
    value is Map &&
    value.length == keys.length &&
    value.keys.every(keys.contains);
bool _label(dynamic value) =>
    value is String &&
    value.trim().isNotEmpty &&
    value.length <= 100 &&
    !RegExp(r'[\x00-\x1f\x7f]').hasMatch(value);
bool _revision(dynamic value, {int minimum = 1}) =>
    value is int && value >= minimum && value <= 9007199254740991;
bool _id(dynamic value) =>
    value is String && RegExp(r'^[A-Za-z][A-Za-z0-9.-]{0,63}$').hasMatch(value);
String _canonical(dynamic value) {
  if (value is Map) {
    final keys = value.keys.cast<String>().toList()..sort();
    return '{${keys.map((k) => '${jsonEncode(k)}:${_canonical(value[k])}').join(',')}}';
  }
  if (value is List) return '[${value.map(_canonical).join(',')}]';
  return jsonEncode(value);
}

/// Closed declaration structure. Registered policies own business constraints.
Map<String, dynamic>? validatedChoiceForm(
  dynamic raw,
  dynamic state,
  String contract,
) {
  try {
    return _validatedChoiceForm(raw, state, contract);
  } catch (_) {
    return null;
  }
}

Map<String, dynamic>? _validatedChoiceForm(
  dynamic raw,
  dynamic state,
  String contract,
) {
  final contractPolicy = choiceContractPolicies[contract];
  final policy = contractPolicy?.fields;
  if (policy == null ||
      state is! Map ||
      !_closed(raw, {
        'schema',
        'contractId',
        'contractVersion',
        'formId',
        'binding',
        'fields',
      }) ||
      raw['schema'] != 'choice-form.v1' ||
      raw['contractId'] != contract ||
      raw['contractVersion'] != 1 ||
      raw['formId'] is! String ||
      !RegExp(r'^form-[0-9a-f]{64}$').hasMatch(raw['formId']) ||
      !_closed(raw['binding'], contractPolicy!.bindingKeys)) {
    return null;
  }
  final b = raw['binding'] as Map, context = b['context'];
  if (!_closed(context, {'creatureId', 'sceneRevision'}) ||
      !_id(context['creatureId']) ||
      context['creatureId'] != state['activeCreatureId'] ||
      !_revision(context['sceneRevision']) ||
      state['context'] is! Map ||
      _canonical(context) != _canonical(state['context'])) {
    return null;
  }
  final bindingPolicy = contractPolicy.validateBinding(state, b);
  if (bindingPolicy == null) return null;
  final mustReadOnly = bindingPolicy.mustReadOnly;
  final fields = raw['fields'];
  if (fields is! List || fields.length != policy.length) return null;
  final ids = <String>{};
  for (final f in fields) {
    if (!_closed(f, {
          'id',
          'label',
          'type',
          'required',
          'readOnly',
          'options',
          'value',
        }) ||
        !policy.containsKey(f['id']) ||
        !ids.add(f['id']) ||
        !_label(f['label']) ||
        f['type'] != 'choice' ||
        f['required'] != true ||
        f['readOnly'] is! bool ||
        (mustReadOnly && f['readOnly'] != true) ||
        f['options'] is! List ||
        (f['options'] as List).isEmpty ||
        (f['options'] as List).length > policy[f['id']]!.length) {
      return null;
    }
    final values = <String>{};
    for (final o in f['options']) {
      if (!_closed(o, {'value', 'label'}) ||
          !policy[f['id']]!.contains(o['value']) ||
          !values.add(o['value']) ||
          !_label(o['label'])) {
        return null;
      }
    }
    if (f['value'] != null && !values.contains(f['value'])) return null;
  }
  return jsonDecode(jsonEncode(raw)) as Map<String, dynamic>;
}

/// Local draft, never a lease. A changed binding cannot silently carry dirty values.
class ChoiceDraft {
  Map<String, dynamic>? current, display;
  final Map<String, String> values = {};
  bool stale = false;
  int viewGeneration = 0;
  bool get dirty =>
      display != null &&
      (display!['fields'] as List).any((f) => values[f['id']] != f['value']);
  bool get ready =>
      current != null &&
      !stale &&
      (current!['fields'] as List).every(
        (f) =>
            f['readOnly'] == false &&
            (f['options'] as List).any((o) => o['value'] == values[f['id']]),
      );
  bool get saved =>
      current != null &&
      !stale &&
      (current!['fields'] as List).every((f) => values[f['id']] == f['value']);
  void reconcile(
    dynamic raw,
    dynamic state,
    String contract, {
    bool acknowledged = false,
  }) {
    final next = validatedChoiceForm(raw, state, contract);
    final wasDirty = dirty;
    final same =
        next != null &&
        display != null &&
        next['formId'] == display!['formId'] &&
        _canonical(next['binding']) == _canonical(display!['binding']);
    final compatible =
        next != null &&
        values.entries.every(
          (entry) => (next['fields'] as List).any(
            (f) =>
                f['id'] == entry.key &&
                f['readOnly'] == false &&
                (f['options'] as List).any((o) => o['value'] == entry.value),
          ),
        );
    current = next;
    if (acknowledged || display == null || !wasDirty && !stale) {
      reload();
      return;
    }
    if (!same || !compatible) {
      stale = true;
      return;
    }
    if (!stale) display = next;
  }

  void reload() {
    if (current == null) {
      stale = true;
      return;
    }
    display = current;
    values.clear();
    stale = false;
    viewGeneration++;
    for (final f in display!['fields']) {
      if (f['value'] is String) values[f['id']] = f['value'];
    }
  }

  Map<String, dynamic> submission() => {
    'formId': current!['formId'],
    'binding': current!['binding'],
    'values': Map<String, String>.from(values),
  };
}

class ChoiceForm extends StatelessWidget {
  const ChoiceForm({
    super.key,
    required this.draft,
    required this.onChanged,
    this.disabled = false,
    this.fieldKey,
  });
  final ChoiceDraft draft;
  final VoidCallback onChanged;
  final bool disabled;
  final String Function(String)? fieldKey;
  @override
  Widget build(BuildContext context) => KeyedSubtree(
    key: ValueKey(draft.viewGeneration),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (draft.current == null)
          const Text('服务表单契约不可用，不能编辑或提交。', key: Key('choice-unavailable')),
        if (draft.stale) ...[
          const Text('服务状态已变化。保留原草稿供核对，不能直接提交或自动迁移。', key: Key('choice-stale')),
          TextButton(
            key: const Key('choice-reload'),
            onPressed: disabled || draft.current == null
                ? null
                : () {
                    draft.reload();
                    onChanged();
                  },
            child: const Text('重新载入当前表单（丢弃旧草稿）'),
          ),
        ],
        if (draft.display != null)
          for (final f in draft.display!['fields'])
            DropdownButtonFormField<String>(
              key: ValueKey(
                fieldKey?.call(f['id']) ??
                    'choice-${draft.display!['formId']}-${f['id']}',
              ),
              initialValue: draft.values[f['id']],
              decoration: InputDecoration(labelText: f['label']),
              items: [
                for (final o in f['options'])
                  DropdownMenuItem<String>(
                    value: o['value'],
                    child: Text(o['label']),
                  ),
              ],
              onChanged:
                  disabled ||
                      draft.stale ||
                      draft.current == null ||
                      f['readOnly'] == true
                  ? null
                  : (value) {
                      if (value != null) draft.values[f['id']] = value;
                      onChanged();
                    },
            ),
      ],
    ),
  );
}
