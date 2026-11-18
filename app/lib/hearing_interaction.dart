import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'api.dart';
import 'interaction_contract.dart';

/// One bounded, cancellable attempt. Cancellation does not assert server rollback.
Future<Map<String, dynamic>> generateHearingInteraction(
  http.Client client,
  Map<String, dynamic> source,
  Future<void> cancel,
) async {
  final abort = Completer<void>();
  void stop() {
    if (!abort.isCompleted) abort.complete();
  }

  cancel.then((_) => stop());
  final timer = Timer(const Duration(seconds: 65), stop);
  try {
    final request =
        http.AbortableRequest(
            'POST',
            Uri.parse('http://127.0.0.1:8091/scene/interaction-generate'),
            abortTrigger: abort.future,
          )
          ..followRedirects = false
          ..headers.addAll({
            'Content-Type': 'application/json',
            'X-Summon-Lab': 'synthetic',
          })
          ..body = jsonEncode(source);
    final sending = client.send(request);
    // An injected transport may ignore abort. Retire any late response too.
    sending.then((r) {
      if (abort.isCompleted) unawaited(r.stream.listen((_) {}).cancel());
    }, onError: (Object _) {});
    final response = await Future.any([
      sending,
      abort.future.then<http.StreamedResponse>(
        (_) => throw http.RequestAbortedException(request.url),
      ),
    ]);
    final bytes = await _boundedGenerationBody(response.stream, abort.future);
    final raw = jsonDecode(utf8.decode(bytes, allowMalformed: false));
    if (response.statusCode != 200) {
      throw ApiFailure(
        response.statusCode,
        raw is Map && raw['error'] is String
            ? raw['error']
            : 'generation_unavailable',
      );
    }
    final valid = validatedHearingGeneration(raw, source);
    if (valid == null) {
      throw const ApiFailure(502, 'invalid_hearing_generation');
    }
    return valid;
  } finally {
    timer.cancel();
    stop();
  }
}

Future<List<int>> _boundedGenerationBody(
  Stream<List<int>> stream,
  Future<void> abort,
) {
  final done = Completer<List<int>>(), bytes = BytesBuilder(copy: false);
  late StreamSubscription<List<int>> subscription;
  void fail(Object error) {
    if (done.isCompleted) return;
    bytes.clear();
    done.completeError(error);
    unawaited(subscription.cancel());
  }

  subscription = stream.listen(
    (chunk) {
      if (done.isCompleted) return;
      if (bytes.length + chunk.length > 128 * 1024) {
        fail(const ApiFailure(502, 'generation_response_too_large'));
        return;
      }
      bytes.add(chunk);
    },
    onError: (Object e) => fail(e),
    onDone: () {
      if (!done.isCompleted) done.complete(bytes.takeBytes());
    },
  );
  abort.then((_) => fail(http.RequestAbortedException()));
  return done.future;
}

Map<String, dynamic>? validatedHearingGeneration(dynamic r, Map source) {
  bool exact(dynamic v, Set<String> keys) =>
      v is Map && v.length == keys.length && v.keys.every(keys.contains);
  bool integer(dynamic v) => v is int && v >= 0 && v <= 9007199254740991;
  try {
    interactionCanonical(
      r,
    ); // Unicode scalars, safe numbers, depth and total bytes.
    if (!exact(r, {
          'schema',
          'eventId',
          'context',
          'kind',
          'creation',
          'replayed',
          'modelId',
          'sourceTrust',
          'plannerInvoked',
          'speech',
          'voiceAvailable',
          if (r is Map && r['replayed'] == false) 'proposal',
        }) ||
        r['schema'] != 'hearing-interaction-generation.v1' ||
        r['eventId'] != source['eventId'] ||
        interactionCanonical(r['context']) !=
            interactionCanonical(source['context']) ||
        r['sourceTrust'] != 'host-supplied-metadata' ||
        r['speech'] != null ||
        r['voiceAvailable'] != false ||
        r['replayed'] is! bool ||
        r['plannerInvoked'] != !r['replayed']) {
      return null;
    }
    if (r['replayed']) {
      if (r['kind'] != 'form' || r['modelId'] != null) return null;
    } else {
      if (r['modelId'] is! String ||
          r['modelId'].trim().isEmpty ||
          r['modelId'].runes.length > 120 ||
          RegExp(r'[\x00-\x1f\x7f]').hasMatch(r['modelId'])) {
        return null;
      }
      final p = r['proposal'];
      final field = r['kind'] == 'form'
          ? 'program'
          : r['kind'] == 'clarify'
          ? 'question'
          : r['kind'] == 'none'
          ? 'reason'
          : null;
      if (field == null ||
          !exact(p, {'kind', field, 'authorityGranted', 'semanticsVerified'}) ||
          p['kind'] != r['kind'] ||
          p['authorityGranted'] != false ||
          p['semanticsVerified'] != false) {
        return null;
      }
      if (field == 'program') {
        if (validatedInteractionProgram(p[field]) == null) return null;
      } else if (p[field] is! String ||
          p[field].trim().isEmpty ||
          p[field].runes.length > 240 ||
          RegExp(r'[\x00-\x1f\x7f]').hasMatch(p[field])) {
        return null;
      }
    }
    if (r['kind'] == 'form') {
      final c = r['creation'], a = c is Map ? c['ack'] : null;
      if (!exact(c, {'status', 'commandId', 'ack'}) ||
          c['status'] != 'completed' ||
          !interactionId(c['commandId']) ||
          !exact(a, {
            'fact',
            'sessionId',
            'revision',
            'programDigest',
            'draftRevision',
            'expiresAt',
          }) ||
          a['fact'] != 'interaction_created' ||
          !interactionId(a['sessionId']) ||
          !integer(a['revision']) ||
          a['revision'] < 1 ||
          !integer(a['draftRevision']) ||
          a['draftRevision'] != 0 ||
          !integer(a['expiresAt']) ||
          a['programDigest'] is! String ||
          !RegExp(r'^sha256:[a-f0-9]{64}$').hasMatch(a['programDigest']) ||
          (!r['replayed'] &&
              a['programDigest'] !=
                  r['proposal']['program']['programDigest'])) {
        return null;
      }
    } else if (r['creation'] != null) {
      return null;
    }
    return jsonDecode(jsonEncode(r)) as Map<String, dynamic>;
  } catch (_) {
    return null;
  }
}
