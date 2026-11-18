import 'dart:js_interop';

// location.origin, not document.baseURI: a <base> element cannot change authority.
@JS('globalThis.location.origin')
external JSString get _locationOrigin;
Uri currentPreviewOrigin() => Uri.parse(_locationOrigin.toDart);

@JS('globalThis.location.assign')
external void _assign(JSString path);
void openPreviewLogin() => _assign('/preview/login'.toJS);
