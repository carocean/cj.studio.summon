import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'interaction_contract.dart';

bool _keys(dynamic v, Set<String> keys) =>
    v is Map && v.length == keys.length && v.keys.every(keys.contains);
bool _id(dynamic v) =>
    v is String && RegExp(r'^[A-Za-z][A-Za-z0-9_-]{0,63}$').hasMatch(v);
bool _int(dynamic v, [int min = 0]) =>
    v is int && v >= min && v <= 9007199254740991;
bool _size(dynamic v, int limit) =>
    utf8.encode(interactionCanonical(v)).length <= limit;
dynamic _freeze(dynamic v) => v is Map
    ? Map<String, dynamic>.unmodifiable(
        v.map((k, v) => MapEntry(k as String, _freeze(v))),
      )
    : v is List
    ? List<dynamic>.unmodifiable(v.map(_freeze))
    : v;

/// Pure structural validation, not acquisition evidence or reading permission.
Map<String, dynamic>? validatedReadingResource(dynamic raw) {
  try {
    if (!_size(raw, 49152) ||
        !_keys(raw, {
          'schema',
          'resourceId',
          'provenance',
          'blocks',
          'contentDigest',
          'authorityGranted',
        }) ||
        raw['schema'] != 'compiled-reading-resource.v1' ||
        raw['authorityGranted'] != false ||
        !_id(raw['resourceId'])) {
      return null;
    }
    final p = raw['provenance'], blocks = raw['blocks'];
    if (!_keys(p, {'kind', 'referenceId'}) ||
        p['kind'] != 'host-declared' ||
        !_id(p['referenceId']) ||
        blocks is! List ||
        blocks.isEmpty ||
        blocks.length > 64) {
      return null;
    }
    final ids = <String>{};
    var count = 0;
    for (final b in blocks) {
      if (!_keys(b, {'id', 'text'}) ||
          !_id(b['id']) ||
          !ids.add(b['id']) ||
          b['text'] is! String) {
        return null;
      }
      final text = b['text'] as String, length = text.runes.length;
      if (length < 1 ||
          length > 2000 ||
          RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]').hasMatch(text)) {
        return null;
      }
      count += length;
    }
    if (count > 8000) return null;
    final digest =
        'sha256:${sha256.convert(utf8.encode('cj.summon.c1\u0000reading-content\u0000${interactionCanonical({'resourceId': raw['resourceId'], 'blocks': blocks})}'))}';
    if (raw['contentDigest'] != digest) return null;
    return _freeze(raw) as Map<String, dynamic>;
  } catch (_) {
    return null;
  }
}

bool _presentation(dynamic p) =>
    _keys(p, {
      'background',
      'fontRef',
      'textScalePermille',
      'flow',
      'pageControls',
    }) &&
    p['background'] is String &&
    RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(p['background']) &&
    _id(p['fontRef']) &&
    _int(p['textScalePermille'], 800) &&
    p['textScalePermille'] <= 2000 &&
    ['scroll', 'paged'].contains(p['flow']) &&
    p['pageControls'] is bool;
Map<String, dynamic>? validatedReadingState(dynamic resource, dynamic raw) {
  try {
    final r = validatedReadingResource(resource);
    if (r == null ||
        !_size(raw, 4096) ||
        !_keys(raw, {
          'schema',
          'resourceId',
          'contentDigest',
          'revision',
          'anchor',
          'presentation',
        }) ||
        raw['schema'] != 'reading-state.v1' ||
        raw['resourceId'] != r['resourceId'] ||
        raw['contentDigest'] != r['contentDigest'] ||
        !_int(raw['revision'], 1) ||
        !_presentation(raw['presentation'])) {
      return null;
    }
    final a = raw['anchor'];
    if (!_keys(a, {'blockId', 'scalarOffset'}) || !_int(a['scalarOffset'])) {
      return null;
    }
    final blocks = (r['blocks'] as List).where((b) => b['id'] == a['blockId']);
    if (blocks.length != 1 ||
        a['scalarOffset'] > (blocks.single['text'] as String).runes.length) {
      return null;
    }
    return _freeze(raw) as Map<String, dynamic>;
  } catch (_) {
    return null;
  }
}

/// Availability is separate. Failure never rewrites a stored font or anchor.
bool readingFontAvailable(dynamic presentation, dynamic capabilities) {
  try {
    if (!_size(presentation, 4096) ||
        !_presentation(presentation) ||
        !_size(capabilities, 4096) ||
        !_keys(capabilities, {'installedFontIds'})) {
      return false;
    }
    final ids = capabilities['installedFontIds'];
    return ids is List &&
        ids.length <= 16 &&
        ids.every(_id) &&
        ids.toSet().length == ids.length &&
        ids.contains(presentation['fontRef']);
  } catch (_) {
    return false;
  }
}

/// Scalar boundary conversion, not grapheme segmentation. Throws on malformed input.
int readingScalarToUtf16(String text, int offset) {
  interactionCanonical(text);
  if (offset < 0 || offset > text.runes.length) {
    throw const FormatException('invalid_reading_anchor');
  }
  return String.fromCharCodes(text.runes.take(offset)).length;
}
