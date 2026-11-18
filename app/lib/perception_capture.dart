import 'dart:async';
import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:material_ui/material_ui.dart';
import 'package:record/record.dart';

import 'perception_files.dart';

class CapturedSense {
  const CapturedSense(this.bytes, this.mimeType);
  final Uint8List bytes;
  final String mimeType;
}

abstract class SenseCapture {
  Future<CapturedSense?> photograph(BuildContext context);
  Future<void> startHearing();
  Future<CapturedSense?> stopHearing();
  Future<void> cancel();
  Future<void> dispose();
}

/// Actual platform adapters. Widget fakes do not validate device hardware.
class PlatformSenseCapture implements SenseCapture {
  final AudioRecorder _recorder = AudioRecorder();
  StreamSubscription<Uint8List>? _stream;
  final List<int> _pcm = [];
  bool _failed = false, _disposed = false;
  int _generation = 0;
  @override
  Future<CapturedSense?> photograph(BuildContext context) =>
      Navigator.of(context).push<CapturedSense>(
        MaterialPageRoute(builder: (_) => const CameraCapturePage()),
      );
  @override
  Future<void> startHearing() async {
    await cancel();
    final generation = _generation;
    if (_disposed) throw StateError('capture_disposed');
    if (!await _recorder.hasPermission()) {
      throw StateError('microphone_permission_denied');
    }
    if (_disposed || generation != _generation) {
      throw StateError('capture_cancelled');
    }
    _failed = false;
    final source = await _recorder.startStream(
      const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: 16000,
        numChannels: 1,
      ),
    );
    if (_disposed || generation != _generation) {
      await _recorder.cancel();
      throw StateError('capture_cancelled');
    }
    _stream = source.listen(
      (chunk) {
        // 15 seconds at 16kHz, mono signed PCM16. Never retain unlimited media.
        if (_pcm.length + chunk.length > 480000) {
          _failed = true;
          unawaited(_recorder.cancel().catchError((_) {}));
        } else if (!_failed) {
          _pcm.addAll(chunk);
        }
      },
      onError: (_) {
        _failed = true;
      },
    );
  }

  @override
  Future<CapturedSense?> stopHearing() async {
    await _recorder.stop();
    await _stream?.cancel();
    _stream = null;
    if (_failed || _pcm.isEmpty || _pcm.length.isOdd) {
      _pcm.clear();
      throw StateError('audio_capture_failed_or_limit');
    }
    final data = Uint8List.fromList(_pcm);
    _pcm.clear();
    return CapturedSense(pcm16Wav(data), 'audio/wav');
  }

  @override
  Future<void> cancel() async {
    _generation++;
    await _stream?.cancel();
    _stream = null;
    _pcm.clear();
    await _recorder.cancel();
  }

  @override
  Future<void> dispose() async {
    _disposed = true;
    try {
      await cancel();
    } finally {
      await _recorder.dispose();
    }
  }
}

Uint8List pcm16Wav(Uint8List pcm) {
  final bytes = Uint8List(44 + pcm.length);
  final view = ByteData.sublistView(bytes);
  void tag(int at, String value) {
    bytes.setRange(at, at + value.length, value.codeUnits);
  }

  tag(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, Endian.little);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, Endian.little);
  view.setUint16(20, 1, Endian.little);
  view.setUint16(22, 1, Endian.little);
  view.setUint32(24, 16000, Endian.little);
  view.setUint32(28, 32000, Endian.little);
  view.setUint16(32, 2, Endian.little);
  view.setUint16(34, 16, Endian.little);
  tag(36, 'data');
  view.setUint32(40, pcm.length, Endian.little);
  bytes.setRange(44, bytes.length, pcm);
  return bytes;
}

/// Injectable boundary for testing actual camera-page asynchronous lifecycle.
abstract class CameraSession {
  Future<void> initialize();
  Future<XFile> takePicture();
  Widget preview();
  Future<void> dispose();
}

class _PlatformCameraSession implements CameraSession {
  _PlatformCameraSession(CameraDescription description)
    : controller = CameraController(
        description,
        ResolutionPreset.medium,
        enableAudio: false,
      );
  final CameraController controller;
  @override
  Future<void> initialize() => controller.initialize();
  @override
  Future<XFile> takePicture() => controller.takePicture();
  @override
  Widget preview() => CameraPreview(controller);
  @override
  Future<void> dispose() => controller.dispose();
}

CameraSession _createCameraSession(CameraDescription description) =>
    _PlatformCameraSession(description);

class CameraCapturePage extends StatefulWidget {
  const CameraCapturePage({
    super.key,
    this.loadCameras = availableCameras,
    this.createSession = _createCameraSession,
  });
  final Future<List<CameraDescription>> Function() loadCameras;
  final CameraSession Function(CameraDescription) createSession;
  @override
  State<CameraCapturePage> createState() => _CameraCapturePageState();
}

class _CameraCapturePageState extends State<CameraCapturePage>
    with WidgetsBindingObserver {
  CameraSession? _session;
  final Set<CameraSession> _released = {};
  String? _error;
  bool _taking = false, _abandoned = false, _ready = false;
  bool get _active => mounted && !_abandoned;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_initialize());
  }

  void _release(CameraSession? session) {
    if (session == null || !_released.add(session)) return;
    // Start disposal immediately, including a pending initialization. Native
    // camera plugins can defer hardware teardown until initialization settles.
    unawaited(session.dispose().catchError((_) {}));
  }

  void _abandon() {
    if (_abandoned) return;
    _abandoned = true;
    _ready = false;
    _release(_session);
    if (mounted) {
      setState(() {});
      Navigator.of(context).maybePop();
    }
  }

  Future<void> _initialize() async {
    CameraSession? session;
    try {
      final cameras = await widget.loadCameras();
      if (!_active) return; // Never create a camera from late enumeration.
      if (cameras.isEmpty) throw StateError('no_camera');
      final camera =
          cameras
              .where((c) => c.lensDirection == CameraLensDirection.back)
              .firstOrNull ??
          cameras.first;
      session = widget.createSession(camera);
      _session = session; // Own it before the first initialization await.
      await session.initialize().timeout(const Duration(seconds: 15));
      if (!_active) {
        _release(session);
        return;
      }
      setState(() => _ready = true);
    } catch (_) {
      _release(session);
      if (_active) {
        setState(() {
          _ready = false;
          _error = '无法启用相机。请检查权限、设备及 HTTPS/localhost 环境。';
        });
      }
    }
  }

  Future<void> _take() async {
    final session = _session;
    if (!_active || !_ready || _taking || session == null) return;
    setState(() => _taking = true);
    try {
      final file = await session.takePicture();
      late Uint8List bytes;
      try {
        if (!_active) return;
        bytes = await file.readAsBytes();
        if (!_active) return;
      } finally {
        await removeCaptureTemporaryFile(file.path);
      }
      if (!_active) return;
      if (bytes.length > 4 * 1024 * 1024) throw StateError('image_too_large');
      final jpeg = bytes.length > 3 && bytes[0] == 255 && bytes[1] == 216;
      final png = bytes.length > 8 && bytes[0] == 137 && bytes[1] == 80;
      if (!jpeg && !png) throw StateError('unsupported_image_format');
      if (!mounted || _abandoned) return;
      _abandoned = true;
      _ready = false;
      _release(session);
      Navigator.pop(
        context,
        CapturedSense(bytes, jpeg ? 'image/jpeg' : 'image/png'),
      );
    } catch (_) {
      if (_active) {
        setState(() {
          _error = '拍摄失败或图像超限，请重试。';
          _taking = false;
        });
      }
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached ||
        state == AppLifecycleState.hidden ||
        (state == AppLifecycleState.inactive && _ready)) {
      _abandon();
    }
    // A transient inactive permission dialog while initializing is not consent
    // to stop; paused/hidden/detached still abandon pending initialization.
  }

  @override
  void dispose() {
    _abandoned = true;
    WidgetsBinding.instance.removeObserver(this);
    _release(_session);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => PopScope<CapturedSense?>(
    onPopInvokedWithResult: (didPop, result) {
      if (didPop) {
        _abandoned = true;
        _ready = false;
        _release(_session);
      }
    },
    child: Scaffold(
      appBar: AppBar(title: const Text('视觉采集 · 仅本次拍摄')),
      body: SafeArea(
        child: Column(
          children: [
            if (_error != null) Text(_error!),
            Expanded(
              child: !_ready || _abandoned
                  ? Center(child: Text(_abandoned ? '相机已关闭' : '正在请求相机权限…'))
                  : _session!.preview(),
            ),
            const Text('拍摄后仍需明确发送。退出即请求关闭相机，不持续监视。'),
            FilledButton(
              key: const Key('camera-take'),
              onPressed: !_ready || _abandoned || _taking ? null : _take,
              child: const Text('拍摄并预览'),
            ),
          ],
        ),
      ),
    ),
  );
}
