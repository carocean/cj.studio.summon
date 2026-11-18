import 'dart:io';

Future<void> removeCaptureTemporaryFile(String path) async {
  try {
    final file = File(path);
    if (await file.exists()) await file.delete();
  } on FileSystemException {
    /* Platform cache may already have removed it. */
  }
}
