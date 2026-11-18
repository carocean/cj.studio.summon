/// Only the trusted backend's bounded registry resolution may name a target.
/// Speech/OCR text and a friendly model reply never supply authority or identity.
Map<String, dynamic>? validatedSpokenCreature(
  dynamic raw,
  Map event,
  String modality,
) {
  const keys = {
    'schema',
    'status',
    'registryRevision',
    'targetCreatureId',
    'targetName',
  };
  if (raw is! Map ||
      raw.length != keys.length ||
      !raw.keys.every(keys.contains) ||
      modality != 'hearing' ||
      event['modality'] != 'hearing' ||
      event['metadata'] is! Map ||
      event['metadata']['routeProposal'] != null ||
      raw['schema'] != 'spoken-creature.v1' ||
      raw['registryRevision'] is! int ||
      raw['registryRevision'] < 1 ||
      raw['registryRevision'] > 9007199254740991) {
    return null;
  }
  if (raw['status'] == 'ready') {
    if (event['metadata']['candidate'] != 'creature-request' ||
        event['status'] != 'awaiting_confirmation' ||
        raw['targetCreatureId'] is! String ||
        !RegExp(r'^[A-Za-z][A-Za-z0-9.-]{0,63}$')
            .hasMatch(raw['targetCreatureId']) ||
        raw['targetName'] is! String ||
        (raw['targetName'] as String).trim().isEmpty ||
        (raw['targetName'] as String).runes.length > 64 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(raw['targetName'])) {
      return null;
    }
  } else if (!['ambiguous', 'unavailable'].contains(raw['status']) ||
      raw['targetCreatureId'] != null ||
      raw['targetName'] != null ||
      event['metadata']['candidate'] != null ||
      event['status'] != 'observation') {
    return null;
  }
  return Map<String, dynamic>.from(raw);
}
