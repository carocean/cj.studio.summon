import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:crypto/crypto.dart';

import 'api.dart';
import 'interaction_contract.dart';

bool validUserText(String text) {
  try {
    interactionCanonical(text);
    return text.trim().isNotEmpty &&
        text.runes.length <= 4000 &&
        utf8.encode(text).length <= 16000;
  } catch (_) {
    return false;
  }
}

bool _exact(dynamic v, Set<String> keys) =>
    v is Map && v.length == keys.length && v.keys.every(keys.contains);
bool _int(dynamic v, [int min = 0]) =>
    v is int && v >= min && v <= 9007199254740991;
bool _label(dynamic v, int limit) =>
    v is String &&
    v.trim().isNotEmpty &&
    v.runes.length <= limit &&
    !RegExp(r'[\x00-\x1f\x7f-\x9f]').hasMatch(v);
Map<String, dynamic>? textGenerationState(dynamic r) {
  try {
    interactionCanonical(r);
    if (!_exact(r, {
          'enabled',
          'generation',
          'attemptCount',
          'attemptLimit',
          'plannerAvailable',
          'ttlMs',
        }) ||
        r['enabled'] is! bool ||
        r['plannerAvailable'] is! bool ||
        !_int(r['generation']) ||
        !_int(r['attemptCount']) ||
        !_int(r['attemptLimit'], 1) ||
        r['attemptLimit'] > 64 ||
        r['attemptCount'] > r['attemptLimit'] ||
        !_int(r['ttlMs'], 1) ||
        r['ttlMs'] > 60000) {
      return null;
    }
    return Map<String, dynamic>.from(r);
  } catch (_) {
    return null;
  }
}

Map<String, dynamic>? textGenerationRecord(dynamic r, String commandId) {
  try {
    interactionCanonical(r);
    if (r is! Map || r['commandId'] != commandId || !interactionId(commandId)) {
      return null;
    }
    final status = r['status'];
    if (status == 'completed') {
      if (!_exact(r, {'commandId', 'status', 'result'})) return null;
      final result = r['result'];
      if (result is! Map ||
          result['inputKind'] != 'user-text' ||
          result['sourceTrust'] != 'host-supplied-metadata' ||
          !_label(result['modelId'], 120)) {
        return null;
      }
      if (result['kind'] == 'form') {
        final a = result['creation'];
        if (!_exact(result, {
              'kind',
              'creation',
              'inputKind',
              'sourceTrust',
              'modelId',
            }) ||
            !_exact(a, {
              'fact',
              'sessionId',
              'revision',
              'programDigest',
              'draftRevision',
              'expiresAt',
            }) ||
            a['fact'] != 'interaction_created' ||
            !interactionId(a['sessionId']) ||
            (a['revision'] is! int || a['revision'] != 1) ||
            a['draftRevision'] is! int ||
            a['draftRevision'] != 0 ||
            a['programDigest'] is! String ||
            !RegExp(r'^sha256:[0-9a-f]{64}$').hasMatch(a['programDigest']) ||
            !_int(a['expiresAt'], 1)) {
          return null;
        }
      } else {
        final field = result['kind'] == 'clarify'
            ? 'question'
            : result['kind'] == 'none'
            ? 'reason'
            : null;
        if (field == null ||
            !_exact(result, {
              'kind',
              field,
              'inputKind',
              'sourceTrust',
              'modelId',
            }) ||
            !_label(result[field], 240)) {
          return null;
        }
      }
    } else {
      if (![
            'running',
            'not_started',
            'cancelled',
            'expired',
            'interrupted',
            'failed',
          ].contains(status) ||
          !_exact(r, {
            'commandId',
            'status',
            if (r.containsKey('reason')) 'reason',
          }) ||
          (r.containsKey('reason') && !_label(r['reason'], 120))) {
        return null;
      }
    }
    return jsonDecode(jsonEncode(r)) as Map<String, dynamic>;
  } catch (_) {
    return null;
  }
}

String textSourceReference(String ownerId, String commandId) =>
    'textgen-${sha256.convert(utf8.encode('cj.summon.c1\u0000text-generation-key\u0000${interactionCanonical([ownerId, 'source:$commandId'])}')).toString().substring(0, 48)}';

bool textFormMatches(Map view, Map receipt, Map context) {
  final result = receipt['result'], a = result?['creation'];
  return receipt['status'] == 'completed' &&
      result?['kind'] == 'form' &&
      view['sessionId'] == a['sessionId'] &&
      view['revision'] == a['revision'] &&
      view['expiresAt'] == a['expiresAt'] &&
      view['expiresAt'] > DateTime.now().millisecondsSinceEpoch &&
      view['program']['programDigest'] == a['programDigest'] &&
      view['draft']['revision'] == a['draftRevision'] &&
      (view['draft']['values'] as Map).values.every((v) => v == null) &&
      view['changeCount'] == 0 &&
      view['saveCount'] == 0 &&
      view['lastNoteId'] == null &&
      interactionCanonical(view['context']) == interactionCanonical(context) &&
      view['source']['kind'] == 'model-proposal' &&
      view['source']['referenceId'] ==
          textSourceReference(view['ownerId'], receipt['commandId']) &&
      view['source']['modelId'] == result['modelId'];
}

class TextInteractionDraft {
  String text = '';
  Map<String, dynamic>? context, body, record;
  String? returnSessionId, message;
  bool cancelRequested = false;
  bool get terminal => [
    'completed',
    'failed',
    'cancelled',
    'expired',
    'interrupted',
  ].contains(record?['status']);
  bool get hasWork => text.isNotEmpty || body != null;
}

/// One bounded request. Disconnect never issues an implicit host cancellation.
Future<Map<String, dynamic>> textGenerationRequest(
  http.Client client,
  String action,
  Map<String, dynamic>? body, {
  Future<void>? cancel,
}) async {
  if (![
        'textgen-state',
        'textgen-generate',
        'textgen-query',
        'textgen-cancel',
      ].contains(action) ||
      (action == 'textgen-state') != (body == null)) {
    throw const ApiFailure(0, 'invalid_textgen_action');
  }
  final abort = Completer<void>();
  void stop() {
    if (!abort.isCompleted) abort.complete();
  }

  if (cancel != null) unawaited(cancel.then((_) => stop()));
  final timer = Timer(
    Duration(seconds: action == 'textgen-generate' ? 60 : 10),
    stop,
  );
  try {
    final request = http.AbortableRequest(
      body == null ? 'GET' : 'POST',
      Uri.parse('http://127.0.0.1:8091/scene/$action'),
      abortTrigger: abort.future,
    )..followRedirects = false;
    if (body != null) {
      request.headers.addAll({
        'Content-Type': 'application/json',
        'X-Summon-Lab': 'synthetic',
      });
      request.body = jsonEncode(body);
    }
    final sending = client.send(request);
    unawaited(
      sending.then((r) {
        if (abort.isCompleted) unawaited(r.stream.listen((_) {}).cancel());
      }, onError: (Object _) {}),
    );
    final r = await Future.any([
      sending,
      abort.future.then<http.StreamedResponse>(
        (_) => throw http.RequestAbortedException(),
      ),
    ]);
    final done = Completer<List<int>>(), bytes = BytesBuilder(copy: false);
    StreamSubscription<List<int>>? sub;
    void fail(Object e) {
      if (done.isCompleted) return;
      bytes.clear();
      done.completeError(e);
      unawaited(sub?.cancel());
    }

    sub = r.stream.listen(
      (chunk) {
        if (done.isCompleted) return;
        if (bytes.length + chunk.length > 128 * 1024) {
          fail(const ApiFailure(502, 'textgen_response_limit'));
          return;
        }
        bytes.add(chunk);
      },
      onError: (Object e) => fail(e),
      onDone: () {
        if (!done.isCompleted) done.complete(bytes.takeBytes());
      },
    );
    unawaited(abort.future.then((_) => fail(http.RequestAbortedException())));
    final data = jsonDecode(
      utf8.decode(await done.future, allowMalformed: false),
    );
    if (abort.isCompleted) throw http.RequestAbortedException();
    if (r.statusCode != 200) {
      throw ApiFailure(
        r.statusCode,
        data is Map && data['error'] is String
            ? data['error']
            : 'textgen_failed',
      );
    }
    if (data is! Map<String, dynamic>) {
      throw const ApiFailure(502, 'invalid_textgen_response');
    }
    return data;
  } finally {
    timer.cancel();
    stop();
  }
}
