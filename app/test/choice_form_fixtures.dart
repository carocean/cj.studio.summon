import 'package:summon_app/choice_form.dart';

/// Widget mock state adapter only. Real digest/schema vectors live in runtime fixtures.
void attachChoiceFixtures(Map<String, dynamic> state) {
  state['context'] = {
    'creatureId': state['activeCreatureId'],
    'sceneRevision': 3,
  };
  final context = state['context'];
  Map<String, dynamic> make(
    String contract,
    Map<String, dynamic> binding,
    Map<String, dynamic> values,
    bool readOnly,
  ) => {
    'schema': 'choice-form.v1',
    'contractId': contract,
    'contractVersion': 1,
    'formId': 'form-${List.filled(64, 'a').join()}',
    'binding': binding,
    'fields': [
      for (final entry in choiceContracts[contract]!.entries)
        {
          'id': entry.key,
          'label': entry.key,
          'type': 'choice',
          'required': true,
          'readOnly': readOnly,
          'options': [
            for (final value in entry.value) {'value': value, 'label': value},
          ],
          'value': values[entry.key],
        },
    ],
  };
  final base = <String, dynamic>{
    'context': context,
    'targetCreatureId': null,
    'activityId': null,
    'activityRevision': null,
    'productId': null,
    'instanceId': null,
    'subscriptionRevision': null,
    'subscriptionGeneration': null,
  };
  final a = state['activity'];
  final subs = state['market']?['subscriptions'];
  final matches = subs is List
      ? subs
            .where((s) => s['status'] == 'active' && s['routeGranted'] == true)
            .toList()
      : [];
  final sub = matches.length == 1 ? matches.single : null;
  state['choiceForms'] = {
    'account':
        state['activeCreatureId'] == 'work' &&
            a is Map &&
            a['sceneVisible'] == true
        ? make(
            'synthetic-account.v1',
            {
              ...base,
              'targetCreatureId': 'work',
              'activityId': a['id'],
              'activityRevision': a['revision'],
            },
            {for (final f in a['form']['fields']) f['id']: f['value']},
            a['status'] != 'draft',
          )
        : null,
    'route': sub != null
        ? make(
            'synthetic-route.v1',
            {
              ...base,
              'targetCreatureId': sub['instanceId'],
              'productId': 'demo.maps.v1',
              'instanceId': sub['instanceId'],
              'subscriptionRevision': sub['revision'],
              'subscriptionGeneration': sub['generation'],
            },
            {'from': 'A', 'to': 'C'},
            false,
          )
        : null,
  };
}
