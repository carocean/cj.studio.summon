import 'dart:collection';
import 'dart:convert';

import 'package:crypto/crypto.dart';

bool interactionId(dynamic v) =>
    v is String && RegExp(r'^[A-Za-z][A-Za-z0-9.-]{0,63}$').hasMatch(v);
bool _integer(dynamic v, [int minimum = 0]) =>
    v is int && v >= minimum && v <= 9007199254740991;
bool _closed(dynamic v, Set<String> keys) =>
    v is Map && v.length == keys.length && v.keys.every(keys.contains);
bool _hash(dynamic v) =>
    v is String && RegExp(r'^sha256:[0-9a-f]{64}$').hasMatch(v);
bool _scalar(String value) {
  for (var i = 0; i < value.length; i++) {
    final unit = value.codeUnitAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++i == value.length) return false;
      final next = value.codeUnitAt(i);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/// C1 byte encoding, not an authorization/provenance signature. Throws on an
/// unsupported value. The input is JSON data, never application objects/code.
String interactionCanonical(dynamic value) {
  final ancestors = HashSet<Object>.identity();
  final parts = <String>[];
  var bytes = 0;
  void push(String part) {
    bytes += utf8.encode(part).length;
    if (bytes > 65536) throw const FormatException('c1_record_limit');
    parts.add(part);
  }

  void visit(dynamic item, int depth) {
    if (depth > 32) throw const FormatException('c1_depth_limit');
    if (item == null || item is bool) {
      push(jsonEncode(item));
    } else if (item is int && item.abs() <= 9007199254740991) {
      push(item.toString());
    } else if (item is String) {
      if (!_scalar(item) || utf8.encode(item).length > 16384) {
        throw const FormatException('invalid_c1_string');
      }
      push(jsonEncode(item));
    } else if (item is List || item is Map) {
      if (!ancestors.add(item)) throw const FormatException('c1_cycle');
      try {
        if (item is List) {
          if (item.length > 256) throw const FormatException('c1_list_limit');
          push('[');
          for (var i = 0; i < item.length; i++) {
            if (i > 0) push(',');
            visit(item[i], depth + 1);
          }
          push(']');
        } else {
          final map = item as Map;
          if (map.length > 256 || map.keys.any((k) => k is! String)) {
            throw const FormatException('invalid_c1_map');
          }
          final keys = map.keys.cast<String>().toList()..sort();
          push('{');
          for (var i = 0; i < keys.length; i++) {
            final key = keys[i];
            if (!RegExp(r'^[A-Za-z][A-Za-z0-9_]{0,63}$').hasMatch(key) ||
                ['constructor', 'prototype'].contains(key)) {
              throw const FormatException('invalid_c1_key');
            }
            if (i > 0) push(',');
            push(jsonEncode(key));
            push(':');
            visit(map[key], depth + 1);
          }
          push('}');
        }
      } finally {
        ancestors.remove(item);
      }
    } else {
      throw const FormatException('invalid_c1_value');
    }
  }

  visit(value, 0);
  return parts.join();
}

bool _size(dynamic v, int limit) =>
    utf8.encode(interactionCanonical(v)).length <= limit;
bool _nonBlank(String v) => RegExp(
  r'[^\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]',
).hasMatch(v);
bool _label(dynamic v, int maximum) =>
    v is String &&
    _scalar(v) &&
    _nonBlank(v) &&
    v.runes.length <= maximum &&
    !RegExp(r'[\x00-\x1f\x7f]').hasMatch(v);
bool _fieldId(dynamic v) =>
    v is String &&
    RegExp(r'^[A-Za-z][A-Za-z0-9_]{0,31}$').hasMatch(v) &&
    !['constructor', 'prototype'].contains(v);
bool _context(dynamic v) =>
    _closed(v, {'creatureId', 'sceneRevision'}) &&
    interactionId(v['creatureId']) &&
    _integer(v['sceneRevision'], 1);

bool _declaration(dynamic raw) {
  if (!_size(raw, 16384) ||
      !_closed(raw, {'schema', 'title', 'fields', 'save'}) ||
      raw['schema'] != 'temporary-interaction.v1' ||
      !_label(raw['title'], 120) ||
      !_closed(raw['save'], {'primitive'}) ||
      raw['save']['primitive'] != 'local-draft.save' ||
      raw['fields'] is! List ||
      raw['fields'].isEmpty ||
      raw['fields'].length > 16) {
    return false;
  }
  final ids = <String>{};
  for (final f in raw['fields']) {
    if (f is! Map ||
        !['text', 'multiline', 'choice'].contains(f['type']) ||
        !_closed(f, {
          'id',
          'label',
          'type',
          'required',
          f['type'] == 'choice' ? 'options' : 'maxLength',
        }) ||
        !_fieldId(f['id']) ||
        !ids.add(f['id']) ||
        !_label(f['label'], 80) ||
        f['required'] is! bool) {
      return false;
    }
    if (f['type'] == 'choice') {
      if (f['options'] is! List ||
          f['options'].isEmpty ||
          f['options'].length > 16) {
        return false;
      }
      final values = <String>{};
      for (final option in f['options']) {
        if (!_closed(option, {'value', 'label'}) ||
            !_label(option['value'], 64) ||
            !_label(option['label'], 80) ||
            !values.add(option['value'])) {
          return false;
        }
      }
    } else if (!_integer(f['maxLength'], 1) ||
        f['maxLength'] > (f['type'] == 'text' ? 2000 : 4000)) {
      return false;
    }
  }
  return true;
}

bool _program(dynamic raw) {
  if (!_size(raw, 18000) ||
      !_closed(raw, {
        'schema',
        'revision',
        'parentDigest',
        'declaration',
        'programDigest',
        'authorityGranted',
        'semanticsVerified',
      }) ||
      raw['schema'] != 'compiled-interaction.v1' ||
      !_integer(raw['revision'], 1) ||
      raw['authorityGranted'] != false ||
      raw['semanticsVerified'] != false ||
      !_hash(raw['programDigest']) ||
      (raw['revision'] == 1
          ? raw['parentDigest'] != null
          : !_hash(raw['parentDigest'])) ||
      !_declaration(raw['declaration'])) {
    return false;
  }
  final core = {
    for (final k in ['schema', 'revision', 'parentDigest', 'declaration'])
      k: raw[k],
  };
  final bytes = utf8.encode(
    'cj.summon.c1\u0000interaction-program\u0000${interactionCanonical(core)}',
  );
  return raw['programDigest'] == 'sha256:${sha256.convert(bytes)}';
}

Map<String, dynamic>? validatedInteractionProgram(dynamic raw) {
  try {
    return _program(raw)
        ? jsonDecode(jsonEncode(raw)) as Map<String, dynamic>
        : null;
  } catch (_) {
    return null;
  }
}

bool _values(dynamic program, dynamic values, bool requireComplete) {
  final fields = program['declaration']['fields'] as List;
  if (!_closed(values, fields.map((f) => f['id'] as String).toSet())) {
    return false;
  }
  for (final f in fields) {
    final value = values[f['id']];
    if (value != null) {
      if (value is! String || !_scalar(value)) return false;
      if (f['type'] == 'choice') {
        if (!(f['options'] as List).any((o) => o['value'] == value)) {
          return false;
        }
      } else if (value.runes.length > f['maxLength'] ||
          (f['type'] == 'text'
                  ? RegExp(r'[\x00-\x1f\x7f]')
                  : RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'))
              .hasMatch(value)) {
        return false;
      }
    }
    if (requireComplete &&
        f['required'] &&
        (value == null || !_nonBlank(value as String))) {
      return false;
    }
  }
  return true;
}

/// Local input validation uses Unicode scalar counts, not UTF-16 code units or
/// grapheme clusters. Actual mutation permission remains with the host.
bool interactionValuesValid(
  dynamic program,
  dynamic values, {
  bool requireComplete = false,
}) {
  try {
    if (!_program(program) || !_values(program, values, requireComplete)) {
      return false;
    }
    // Conservative edit envelope: the host also imposes the exact draft cap.
    return _size({
      'schema': 'interaction-draft.v1',
      'programDigest': program['programDigest'],
      'revision': 9007199254740991,
      'values': values,
    }, 16384);
  } catch (_) {
    return false;
  }
}

bool _draft(dynamic program, dynamic draft) =>
    _size(draft, 16384) &&
    _closed(draft, {'schema', 'programDigest', 'revision', 'values'}) &&
    draft['schema'] == 'interaction-draft.v1' &&
    draft['programDigest'] == program['programDigest'] &&
    _integer(draft['revision']) &&
    _values(program, draft['values'], false);
bool _source(dynamic source) =>
    _closed(source, {'kind', 'referenceId', 'modelId'}) &&
    interactionId(source['referenceId']) &&
    (source['kind'] == 'host-declaration'
        ? source['modelId'] == null
        : source['kind'] == 'model-proposal' && _label(source['modelId'], 120));

/// Read-only validator for an active host session. A valid public digest or
/// model-proposal source label is NOT proof of model execution or authority.
Map<String, dynamic>? validatedInteractionSession(
  dynamic raw, {
  required String sessionId,
  required Map context,
  int? now,
}) {
  try {
    final clock = now ?? DateTime.now().millisecondsSinceEpoch;
    if (!_size(raw, 65536) ||
        !_closed(raw, {
          'ownerId',
          'sessionId',
          'context',
          'source',
          'sourceTrust',
          'program',
          'draft',
          'status',
          'createdAt',
          'expiresAt',
          'changeCount',
          'saveCount',
          'lastNoteId',
          'revision',
        }) ||
        !interactionId(sessionId) ||
        raw['sessionId'] != sessionId ||
        !interactionId(raw['ownerId']) ||
        !_context(context) ||
        !_context(raw['context']) ||
        interactionCanonical(context) != interactionCanonical(raw['context']) ||
        !_source(raw['source']) ||
        raw['sourceTrust'] != 'host-supplied-metadata' ||
        !_program(raw['program']) ||
        !_draft(raw['program'], raw['draft']) ||
        raw['status'] != 'open' ||
        !_integer(raw['createdAt']) ||
        !_integer(raw['expiresAt']) ||
        !_integer(clock) ||
        raw['expiresAt'] <= clock ||
        raw['expiresAt'] <= raw['createdAt'] ||
        raw['expiresAt'] - raw['createdAt'] > 900000 ||
        !_integer(raw['changeCount']) ||
        raw['changeCount'] > 32 ||
        !_integer(raw['saveCount']) ||
        raw['saveCount'] > 64 ||
        !(raw['lastNoteId'] == null || interactionId(raw['lastNoteId'])) ||
        !_integer(raw['revision'], 1)) {
      return null;
    }
    return jsonDecode(jsonEncode(raw)) as Map<String, dynamic>;
  } catch (_) {
    return null;
  }
}
