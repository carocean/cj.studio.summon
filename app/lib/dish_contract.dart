/// Strict, immutable view decoded from the synthetic dish host.
/// This validates data, not identity, authority, or a real playback outcome.
class DishView {
  const DishView._({
    required this.sessionId,
    required this.revision,
    required this.creatureId,
    required this.sceneRevision,
    required this.taskId,
    required this.catalogDigest,
    required this.lastSpeechSequence,
    required this.dishId,
    required this.speechPhase,
    required this.view,
    required this.zoomPermille,
    required this.name,
    required this.description,
    required this.imageRef,
  });
  final String sessionId, creatureId, taskId, catalogDigest, view;
  final int revision, sceneRevision, lastSpeechSequence, zoomPermille;
  final String? dishId, speechPhase, name, description, imageRef;

  static Never _bad() => throw const FormatException('invalid_dish_view');
  static Map<String, dynamic> _object(Object? value, List<String> keys) {
    if (value is! Map<String, dynamic> ||
        value.length != keys.length ||
        !keys.every(value.containsKey)) {
      _bad();
    }
    return value;
  }

  static int _integer(Object? v, int min, int max) {
    if (v is! int || v < min || v > max) _bad();
    return v;
  }

  static String _id(Object? v, {bool host = false}) {
    final pattern = host
        ? r'^[A-Za-z][A-Za-z0-9.-]{0,63}$'
        : r'^[A-Za-z][A-Za-z0-9_-]{0,63}$';
    if (v is! String || !RegExp(pattern).hasMatch(v)) _bad();
    return v;
  }

  static String _text(Object? v, int max) {
    if (v is! String ||
        v.trim().isEmpty ||
        v.runes.length > max ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(v)) {
      _bad();
    }
    return v;
  }

  factory DishView.parse(Object? raw) {
    const max = 9007199254740991;
    final r = _object(raw, [
      'sessionId',
      'revision',
      'context',
      'focus',
      'presentation',
    ]);
    final sessionId = _id(r['sessionId'], host: true);
    final revision = _integer(r['revision'], 1, max);
    final c = _object(r['context'], ['creatureId', 'sceneRevision']);
    final creatureId = _id(c['creatureId'], host: true);
    final sceneRevision = _integer(c['sceneRevision'], 1, max);
    final f = _object(r['focus'], [
      'schema',
      'taskId',
      'catalogDigest',
      'revision',
      'lastSpeechSequence',
      'dishId',
      'speech',
      'view',
      'zoomPermille',
    ]);
    if (f['schema'] != 'dish-focus.v1' ||
        _integer(f['revision'], 1, max) != revision) {
      _bad();
    }
    final taskId = _id(f['taskId']);
    final digest = f['catalogDigest'];
    if (digest is! String ||
        !RegExp(r'^sha256:[a-f0-9]{64}$').hasMatch(digest)) {
      _bad();
    }
    final sequence = _integer(f['lastSpeechSequence'], 0, max);
    final dishId = f['dishId'] == null ? null : _id(f['dishId']);
    final view = f['view'];
    if (view is! String || !['none', 'details', 'image'].contains(view)) _bad();
    final zoom = _integer(f['zoomPermille'], 1000, 3000);
    if (zoom % 250 != 0 || (view != 'image' && zoom != 1000)) _bad();
    String? phase;
    if (f['speech'] != null) {
      final s = _object(f['speech'], ['sequence', 'phase']);
      if (_integer(s['sequence'], 1, max) != sequence) _bad();
      final p = s['phase'];
      if (p is! String ||
          !['playback-requested', 'stop-required', 'stopped'].contains(p)) {
        _bad();
      }
      phase = p;
    }
    String? name, description, imageRef;
    if (dishId == null) {
      if (sequence != 0 ||
          phase != null ||
          view != 'none' ||
          r['presentation'] != null) {
        _bad();
      }
    } else {
      if (sequence < 1 ||
          phase == null ||
          (view != 'none' && phase != 'stopped')) {
        _bad();
      }
      final p = _object(r['presentation'], [
        'name',
        'description',
        'imageRef',
        'synthetic',
      ]);
      if (p['synthetic'] != true) _bad();
      name = _text(p['name'], 120);
      description = p['description'] == null
          ? null
          : _text(p['description'], 2000);
      if (p['imageRef'] != null && p['imageRef'] != 'synthetic-soup') _bad();
      imageRef = p['imageRef'] as String?;
      if (view == 'image' && imageRef == null) _bad();
    }
    return DishView._(
      sessionId: sessionId,
      revision: revision,
      creatureId: creatureId,
      sceneRevision: sceneRevision,
      taskId: taskId,
      catalogDigest: digest,
      lastSpeechSequence: sequence,
      dishId: dishId,
      speechPhase: phase,
      view: view,
      zoomPermille: zoom,
      name: name,
      description: description,
      imageRef: imageRef,
    );
  }
}
