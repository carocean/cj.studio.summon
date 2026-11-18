import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:summon_app/interaction_contract.dart';

Map<String, dynamic> fixture() => jsonDecode(
  File('test/fixtures/interaction-program.json').readAsStringSync(),
);
Map<String, dynamic> copy(Map v) => jsonDecode(jsonEncode(v));
Map<String, dynamic>? validate(Map v, {int now = 1000}) =>
    validatedInteractionSession(
      v,
      sessionId: 'fixture-session',
      context: {'creatureId': 'companion', 'sceneRevision': 1},
      now: now,
    );
void sign(Map p) {
  final core = {
    for (final k in ['schema', 'revision', 'parentDigest', 'declaration'])
      k: p[k],
  };
  p['programDigest'] =
      'sha256:${sha256.convert(utf8.encode('cj.summon.c1\u0000interaction-program\u0000${interactionCanonical(core)}'))}';
}

void main() {
  test('actual Node session snapshots validate, start empty, and return independent copies', () {
    final f = fixture(), s = f['initial'] as Map;
    expect(validate(s), s);
    expect(validate(f['filled']), f['filled']);
    expect((s['draft']['values'] as Map).values.every((v) => v == null), true);
    final result = validate(s)!;
    result['program']['declaration']['title'] = 'mutated';
    expect(s['program']['declaration']['title'], '临时 <表单> 😀');
  });
  test(
    'host context, lifetime, source flags and outer closure are required',
    () {
      final s = fixture()['initial'] as Map;
      for (final mutation in <void Function(Map)>[
        (v) => v['context']['sceneRevision'] = 2,
        (v) => v['context']['creatureId'] = 'other',
        (v) => v['sessionId'] = 'other',
        (v) => v['ownerId'] = '../user',
        (v) => v['extra'] = true,
        (v) => v['status'] = 'closed',
        (v) => v['status'] = 'stale',
        (v) => v['status'] = 'expired',
        (v) => v['expiresAt'] = 1000,
        (v) => v['sourceTrust'] = 'proven-model',
        (v) => v['source']['url'] = 'https://example.invalid',
        (v) => v['source']['kind'] = 'unknown',
        (v) => v['revision'] = 0,
        (v) => v['changeCount'] = 33,
        (v) => v['saveCount'] = 65,
      ]) {
        final v = copy(s);
        mutation(v);
        expect(validate(v), null);
      }
      expect(validate(s, now: s['expiresAt']), null);
    },
  );
  test('public program hash binds data but grants neither execution nor provenance', () {
    final p = copy(fixture()['initial']['program']);
    for (final mutation in <void Function(Map)>[
      (v) => v['declaration']['title'] = 'tampered',
      (v) => v['declaration']['fields'] = (v['declaration']['fields'] as List)
          .reversed
          .toList(),
      (v) => v['authorityGranted'] = true,
      (v) => v['semanticsVerified'] = true,
      (v) => v['parentDigest'] = 'sha256:${'0' * 64}',
      (v) => v['revision'] = 0,
    ]) {
      final v = copy(p);
      mutation(v);
      expect(validatedInteractionProgram(v), null);
    }
    p['declaration']['title'] = 'Untrusted literal <a href="x">';
    sign(p);
    final valid = validatedInteractionProgram(p)!;
    expect(valid['authorityGranted'], false);
    expect(valid['semanticsVerified'], false);
  });
  test('arbitrary field names are allowed; model defaults/actions and invalid syntax never are', () {
    final p = copy(fixture()['initial']['program']);
    p['declaration']['fields'] = [
      {
        'id': 'new_7',
        'label': '普通 <b>字面</b>',
        'type': 'text',
        'required': false,
        'maxLength': 50,
      },
    ];
    sign(p);
    expect(validatedInteractionProgram(p), isNotNull);
    for (final mutation in <void Function(Map)>[
      (v) => v['declaration']['save']['primitive'] = 'http.post',
      (v) => v['declaration']['fields'][0]['default'] = 'invented',
      (v) => v['declaration']['fields'][0]['onChange'] = 'execute()',
      (v) => v['declaration']['fields'][0]['type'] = 'password',
      (v) => v['declaration']['fields'][0]['maxLength'] = 2001,
      (v) => v['declaration']['fields'][0]['id'] = 'constructor',
      (v) =>
          v['declaration']['fields'].add(copy(v['declaration']['fields'][0])),
    ]) {
      final v = copy(p);
      mutation(v);
      try {
        sign(v);
      } catch (_) {}
      expect(validatedInteractionProgram(v), null);
    }
  });
  test('draft exact keys and program hash are bound; choices cannot carry free text', () {
    final s = fixture()['filled'] as Map;
    for (final mutation in <void Function(Map)>[
      (v) => v['draft']['programDigest'] = 'sha256:${'0' * 64}',
      (v) => v['draft']['values']['priority'] = 'model-choice',
      (v) => v['draft']['values'].remove('body'),
      (v) => v['draft']['values']['extra'] = 'hidden',
      (v) => v['draft']['values']['subject'] = 42,
      (v) => v['draft']['revision'] = -1,
    ]) {
      final v = copy(s);
      mutation(v);
      expect(validate(v), null);
    }
  });
  test('Unicode scalar versus UTF16/grapheme limits, invalid surrogates, and C0 boundaries match Node', () {
    final p = fixture()['initial']['program'];
    Map<String, dynamic> values(String v) => {
      'subject': v,
      'body': null,
      'priority': 'high',
    };
    expect(
      interactionValuesValid(p, values('😀界'), requireComplete: true),
      true,
    );
    expect(interactionValuesValid(p, values('😀界a')), false);
    expect(interactionValuesValid(p, values('e\u0301')), true);
    expect(interactionValuesValid(p, values('e\u0301a')), false);
    for (final v in ['\ud800', '\udc00', '\ud800x', 'a\n', 'a\u0000']) {
      expect(interactionValuesValid(p, values(v)), false);
    }
    expect(
      interactionValuesValid(p, {...values('好'), 'body': 'a\n\r\tb'}),
      true,
    );
    expect(
      interactionValuesValid(p, {...values('好'), 'body': 'a\u000bb'}),
      false,
    );
    expect(
      interactionValuesValid(p, values(' '), requireComplete: true),
      false,
    );
    // ECMAScript trim does not classify NEXT LINE (0085) as whitespace.
    expect(
      interactionValuesValid(p, values('\u0085'), requireComplete: true),
      true,
    );
    expect(
      interactionValuesValid(p, values('\ufeff'), requireComplete: true),
      false,
    );
  });
  test('canonical encoder rejects non-C1 types, keys, cycles, depth and byte overflow', () {
    expect(interactionCanonical({'z': 1, 'a': '😀'}), '{"a":"😀","z":1}');
    final cyclic = <String, dynamic>{};
    cyclic['self'] = cyclic;
    dynamic deep;
    for (var i = 0; i < 34; i++) {
      deep = [deep];
    }
    for (final value in [
      1.0,
      -0.0,
      double.nan,
      9007199254740992,
      {'__proto__': 1},
      {'constructor': 1},
      {'a.b': 1},
      cyclic,
      deep,
      List.filled(257, null),
      '界' * 5500,
      {
        'a': 'x' * 16000,
        'b': 'x' * 16000,
        'c': 'x' * 16000,
        'd': 'x' * 16000,
        'e': 'x' * 16000,
      },
    ]) {
      expect(() => interactionCanonical(value), throwsFormatException);
    }
  });
  test('draft aggregate byte cap is enforced independently of individual field lengths', () {
    final p = copy(fixture()['initial']['program']);
    p['declaration']['fields'] = List.generate(
      8,
      (i) => {
        'id': 'f$i',
        'label': '字段$i',
        'type': 'multiline',
        'required': false,
        'maxLength': 4000,
      },
    );
    sign(p);
    expect(validatedInteractionProgram(p), isNotNull);
    expect(
      interactionValuesValid(p, {
        for (var i = 0; i < 8; i++) 'f$i': 'x' * 4000,
      }),
      false,
    );
  });
}
