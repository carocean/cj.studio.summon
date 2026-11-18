import 'dart:convert';
import 'dart:math';

import 'interaction_contract.dart';

String usageCommandId() =>
    'use-${List.generate(16, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}';
bool _exact(dynamic v, Set<String> fields) =>
    v is Map && v.length == fields.length && v.keys.every(fields.contains);
bool _number(dynamic v, [int minimum = 0]) =>
    v is int && v >= minimum && v <= 9007199254740991;
bool usageContext(dynamic c) =>
    _exact(c, {'creatureId', 'sceneRevision'}) &&
    interactionId(c['creatureId']) &&
    _number(c['sceneRevision'], 1);
Map<String, dynamic>? validatedUsage(dynamic raw) {
  try {
    interactionCanonical(raw);
    if (!_exact(raw, {
          'schema',
          'items',
          'learningSaturated',
          'minUses',
          'sourceTrust',
        }) ||
        raw['schema'] != 'real-usage-history.v1' ||
        raw['minUses'] is! int ||
        raw['minUses'] != 2 ||
        raw['learningSaturated'] is! bool ||
        raw['sourceTrust'] != 'host-actions-and-client-presentation-reports' ||
        raw['items'] is! List ||
        raw['items'].length > 6) {
      return null;
    }
    final seen = <String>{};
    for (final item in raw['items']) {
      if (!_exact(item, {
            'kind',
            'targetId',
            'useCount',
            'lastUsedAt',
            'label',
          }) ||
          !['creature', 'interaction-session'].contains(item['kind']) ||
          !interactionId(item['targetId']) ||
          !_number(item['useCount'], 2) ||
          !_number(item['lastUsedAt']) ||
          item['label'] is! String ||
          item['label'].trim().isEmpty ||
          item['label'].runes.length > 120 ||
          RegExp(r'[\x00-\x1f\x7f-\x9f]').hasMatch(item['label']) ||
          !seen.add('${item['kind']}:${item['targetId']}')) {
        return null;
      }
    }
    return jsonDecode(jsonEncode(raw)) as Map<String, dynamic>;
  } catch (_) {
    return null;
  }
}

Map<String, dynamic>? validatedUsageAck(
  dynamic ack,
  Map body, {
  required bool selection,
  bool stored = false,
}) {
  try {
    interactionCanonical(ack);
    final usage = ack is Map ? ack['usage'] : null;
    if (stored && usage is Map && usage['reason'] == 'learning-saturated') {
      return null;
    }
    if (!_exact(usage, {'recorded', 'reason', 'useCount'}) ||
        usage['recorded'] is! bool ||
        ![
          'recorded',
          'same-target',
          'learning-saturated',
        ].contains(usage['reason']) ||
        !(usage['useCount'] == null || _number(usage['useCount'], 1)) ||
        (usage['recorded'] &&
            (usage['reason'] != 'recorded' ||
                !_number(usage['useCount'], 1))) ||
        (!usage['recorded'] && usage['reason'] == 'recorded')) {
      return null;
    }
    if (selection) {
      if (!_exact(ack, {'fact', 'creatureId', 'changed', 'context', 'usage'}) ||
          ack['fact'] != 'creature_selection_confirmed' ||
          ack['creatureId'] != body['creatureId'] ||
          ack['changed'] is! bool ||
          !usageContext(ack['context']) ||
          ack['context']['creatureId'] != body['creatureId']) {
        return null;
      }
    } else {
      if (!_exact(ack, {
            'fact',
            'sessionId',
            'revision',
            'programDigest',
            'usage',
          }) ||
          ack['fact'] != 'interaction_presentation_reported' ||
          ack['sessionId'] != body['sessionId'] ||
          ack['revision'] is! int ||
          ack['revision'] != body['expectedRevision'] ||
          ack['programDigest'] != body['programDigest']) {
        return null;
      }
    }
    if (selection) {
      if (!usageContext(body['context'])) return null;
      final changed = body['creatureId'] != body['context']['creatureId'];
      if (ack['changed'] != changed ||
          ack['context']['sceneRevision'] !=
              body['context']['sceneRevision'] + (changed ? 1 : 0)) {
        return null;
      }
      if (!changed && (usage['recorded'] || usage['reason'] != 'same-target')) {
        return null;
      }
      if (changed && usage['reason'] == 'same-target') return null;
    } else if (usage['reason'] == 'same-target') {
      return null;
    }
    return Map<String, dynamic>.from(ack);
  } catch (_) {
    return null;
  }
}

Map<String, dynamic>? validatedUsageResult(
  dynamic raw,
  Map body, {
  required bool selection,
}) =>
    _exact(raw, {'replayed', 'receiptStored', 'ack'}) &&
        raw['replayed'] is bool &&
        raw['receiptStored'] is bool &&
        (raw['replayed'] == false || raw['receiptStored'] == true) &&
        (raw['receiptStored'] == true ||
            (raw['ack'] is Map &&
                raw['ack']['usage'] is Map &&
                raw['ack']['usage']['recorded'] == false))
    ? validatedUsageAck(
        raw['ack'],
        body,
        selection: selection,
        stored: raw['receiptStored'],
      )
    : null;
