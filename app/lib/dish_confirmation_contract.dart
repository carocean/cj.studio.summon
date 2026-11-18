/// Presentation data from a protected host, never proof of identity or consent.
class DishConfirmation {
  const DishConfirmation._(
    this.state,
    this.interactionId,
    this.expiresAt,
    this.dishName,
  );
  final String state;
  final String? interactionId, dishName;
  final int? expiresAt;
  bool get pending => state == 'pending';
  static const states = {
    'pending',
    'presented',
    'cancelled',
    'expired',
    'unavailable',
    'unrecognized',
  };
  factory DishConfirmation.parse(Object? value) {
    const keys = {'schema', 'state', 'interactionId', 'expiresAt', 'dishName'};
    Never bad() => throw const FormatException('invalid_dish_confirmation');
    if (value is! Map<String, dynamic> ||
        value.length != keys.length ||
        !keys.every(value.containsKey) ||
        value['schema'] != 'dish-confirmation.v1' ||
        !states.contains(value['state'])) {
      bad();
    }
    final state = value['state'] as String;
    final id = value['interactionId'],
        expiry = value['expiresAt'],
        name = value['dishName'];
    if (state == 'pending') {
      if (id is! String ||
          !RegExp(r'^[a-f0-9]{32}$').hasMatch(id) ||
          expiry is! int ||
          expiry < 1 ||
          expiry > 9007199254740991 ||
          name is! String ||
          name.trim().isEmpty ||
          name.runes.length > 120 ||
          RegExp(r'[\x00-\x1f\x7f]').hasMatch(name)) {
        bad();
      }
    } else if (id != null || expiry != null || name != null) {
      bad();
    }
    return DishConfirmation._(
      state,
      id as String?,
      expiry as int?,
      name as String?,
    );
  }
}
