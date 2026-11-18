/// Locally trusted contract policies. Never loaded from service declarations.
class ChoiceBindingPolicy {
  const ChoiceBindingPolicy({required this.mustReadOnly});
  final bool mustReadOnly;
}

class ChoiceContractPolicy {
  const ChoiceContractPolicy({
    required this.fields,
    required this.bindingKeys,
    required this.validateBinding,
  });
  final Map<String, List<String>> fields;
  final Set<String> bindingKeys;
  final ChoiceBindingPolicy? Function(Map state, Map binding) validateBinding;
}

const _bindingKeys = {
  'context',
  'targetCreatureId',
  'activityId',
  'activityRevision',
  'productId',
  'instanceId',
  'subscriptionRevision',
  'subscriptionGeneration',
};
const choiceContracts = {
  'synthetic-focus.v1': {
    'topic': ['study', 'tidy', 'write'],
    'duration': ['5', '15', '25'],
    'pace': ['steady', 'gentle'],
  },
  'synthetic-account.v1': {
    'customerAlias': ['demo-a', 'demo-b'],
    'accountType': ['daily', 'savings'],
    'contactPreference': ['none', 'demo-email'],
  },
  'synthetic-route.v1': {
    'from': ['A', 'B', 'C'],
    'to': ['A', 'B', 'C'],
  },
};
bool _revision(dynamic value, {int minimum = 1}) =>
    value is int && value >= minimum && value <= 9007199254740991;
bool _id(dynamic value) =>
    value is String && RegExp(r'^[A-Za-z][A-Za-z0-9.-]{0,63}$').hasMatch(value);

final choiceContractPolicies = <String, ChoiceContractPolicy>{
  'synthetic-focus.v1': ChoiceContractPolicy(
    fields: choiceContracts['synthetic-focus.v1']!,
    bindingKeys: const {
      'context',
      'targetCreatureId',
      'registryRevision',
      'grantRevision',
      'grantGeneration',
      'serviceId',
    },
    validateBinding: _focusBinding,
  ),
  'synthetic-account.v1': ChoiceContractPolicy(
    fields: choiceContracts['synthetic-account.v1']!,
    bindingKeys: _bindingKeys,
    validateBinding: _accountBinding,
  ),
  'synthetic-route.v1': ChoiceContractPolicy(
    fields: choiceContracts['synthetic-route.v1']!,
    bindingKeys: _bindingKeys,
    validateBinding: _routeBinding,
  ),
};
ChoiceBindingPolicy? _accountBinding(Map state, Map b) {
  final context = b['context'];
  final a = state['activity'];
  if (context['creatureId'] != 'work' ||
      b['targetCreatureId'] != 'work' ||
      a is! Map ||
      a['sceneVisible'] != true ||
      !_id(b['activityId']) ||
      b['activityId'] != a['id'] ||
      !_revision(b['activityRevision']) ||
      b['activityRevision'] != a['revision'] ||
      [
        'productId',
        'instanceId',
        'subscriptionRevision',
        'subscriptionGeneration',
      ].any((k) => b[k] != null)) {
    return null;
  }
  if (![
    'draft',
    'submitting',
    'uncertain',
    'completed',
    'expired',
    'cancelled',
  ].contains(a['status'])) {
    return null;
  }
  return ChoiceBindingPolicy(mustReadOnly: a['status'] != 'draft');
}

ChoiceBindingPolicy? _routeBinding(Map state, Map b) {
  final subs = state['market']?['subscriptions'];
  if (subs is! List ||
      b['productId'] != 'demo.maps.v1' ||
      !_id(b['instanceId']) ||
      b['targetCreatureId'] != b['instanceId'] ||
      b['activityId'] != null ||
      b['activityRevision'] != null) {
    return null;
  }
  final matches = subs
      .where(
        (s) =>
            s is Map &&
            s['productId'] == b['productId'] &&
            s['instanceId'] == b['instanceId'],
      )
      .toList();
  if (matches.length != 1) return null;
  final sub = matches.single;
  if (sub['status'] != 'active' ||
      sub['routeGranted'] != true ||
      !_revision(b['subscriptionRevision']) ||
      b['subscriptionRevision'] != sub['revision'] ||
      !_revision(b['subscriptionGeneration'], minimum: 0) ||
      b['subscriptionGeneration'] != sub['generation']) {
    return null;
  }
  return const ChoiceBindingPolicy(mustReadOnly: false);
}

ChoiceBindingPolicy? _focusBinding(Map state, Map b) {
  final focus = state['focus'];
  if (focus is! Map || focus['grant'] is! Map) return null;
  final grant = focus['grant'], target = b['targetCreatureId'];
  if (!_id(target) ||
      target != state['primaryCreatureId'] ||
      target != state['activeCreatureId'] ||
      focus['primaryCreatureId'] != target ||
      b['serviceId'] != 'synthetic.focus.v1' ||
      !_revision(b['registryRevision']) ||
      b['registryRevision'] != state['registryRevision'] ||
      b['registryRevision'] != focus['registryRevision'] ||
      grant['creatureId'] != target ||
      grant['enabled'] != true ||
      !_revision(b['grantRevision']) ||
      b['grantRevision'] != grant['revision'] ||
      !_revision(b['grantGeneration'], minimum: 0) ||
      b['grantGeneration'] != grant['generation'] ||
      focus['activePlan'] != null) {
    return null;
  }
  return const ChoiceBindingPolicy(mustReadOnly: false);
}
