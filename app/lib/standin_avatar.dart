import 'dart:math' as math;

import 'package:material_ui/material_ui.dart';

/// A non-interactive human-shaped stand-in. Idle movement is not sensor evidence.
class StandInAvatar extends StatefulWidget {
  const StandInAvatar({super.key, this.speaking = false});
  final bool speaking;
  @override
  State<StandInAvatar> createState() => _StandInAvatarState();
}

class _StandInAvatarState extends State<StandInAvatar>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final AnimationController _idle;
  bool _foreground = true;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    _idle = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 6),
    );
  }

  void _sync() {
    if (!mounted) return;
    final media = MediaQuery.maybeOf(context);
    final animate =
        _foreground &&
        TickerMode.valuesOf(context).enabled &&
        media?.disableAnimations != true &&
        media?.accessibleNavigation != true;
    if (animate) {
      if (!_idle.isAnimating) _idle.repeat();
    } else {
      _idle.stop();
      _idle.value = 0;
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _sync();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _idle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    image: true,
    label:
        '${widget.speaking ? '播放器报告语音播放中。' : ''}你的拟人替身。听觉关闭，视觉关闭；尚未开启设备采集。呼吸和眨眼只是待机动画，不表示已经听见或看见。',
    child: ExcludeSemantics(
      child: AnimatedBuilder(
        animation: _idle,
        builder: (_, _) => CustomPaint(
          key: const Key('standin-paint'),
          size: const Size(280, 370),
          painter: StandInPainter(
            phase: _idle.value,
            speaking: widget.speaking && _foreground,
          ),
        ),
      ),
    ),
  );
}

class StandInPainter extends CustomPainter {
  const StandInPainter({required this.phase, this.speaking = false});
  final double phase;
  final bool speaking;
  @override
  void paint(Canvas canvas, Size size) {
    final scale = math.min(size.width / 300, size.height / 400);
    canvas.save();
    canvas.translate(
      (size.width - 300 * scale) / 2,
      (size.height - 400 * scale) / 2,
    );
    canvas.scale(scale);
    final breath = math.sin(phase * math.pi * 2);
    canvas.drawOval(
      Rect.fromCenter(
        center: const Offset(150, 349),
        width: 117 + breath * 2,
        height: 12,
      ),
      Paint()..color = const Color(0x102b413e),
    );
    final trousers = Paint()..color = const Color(0xff445a5a);
    for (final x in [121.0, 156.0]) {
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x, 258, 25, 76),
          const Radius.circular(12),
        ),
        trousers,
      );
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(x - 4, 328, 34, 14),
          const Radius.circular(7),
        ),
        Paint()..color = const Color(0xff283d3d),
      );
    }
    canvas.save();
    canvas.translate(0, breath * 1.5);
    final coat = Paint()
      ..shader = const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color(0xffa9b9b3), Color(0xff758f88)],
      ).createShader(const Rect.fromLTWH(100, 181, 100, 103));
    final skin = Paint()
      ..shader = const LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [Color(0xfff0d8bd), Color(0xffd9b798)],
      ).createShader(const Rect.fromLTWH(91, 70, 118, 125));
    // Two relaxed arms and hands, not clickable ear/eye controls.
    for (final side in [-1.0, 1.0]) {
      canvas.save();
      canvas.translate(150 + side * 46, 198);
      canvas.rotate(-side * .12);
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          const Rect.fromLTWH(-11, 0, 22, 62),
          const Radius.circular(11),
        ),
        coat,
      );
      canvas.drawOval(const Rect.fromLTWH(-9, 53, 18, 26), skin);
      canvas.restore();
    }
    final torso = Path()
      ..moveTo(116, 181)
      ..quadraticBezierTo(150, 170, 184, 181)
      ..quadraticBezierTo(199, 205, 195, 271)
      ..quadraticBezierTo(150, 286, 105, 271)
      ..quadraticBezierTo(101, 205, 116, 181);
    canvas.drawPath(torso, coat);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        const Rect.fromLTWH(140, 156, 20, 31),
        const Radius.circular(8),
      ),
      skin,
    );
    canvas.drawPath(
      Path()
        ..moveTo(130, 180)
        ..quadraticBezierTo(150, 197, 170, 180),
      Paint()
        ..color = const Color(0xffd5dfd7)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 5
        ..strokeCap = StrokeCap.round,
    );
    final seam = Paint()
      ..color = const Color(0x297c9189)
      ..strokeWidth = 1.4;
    canvas.drawLine(const Offset(150, 199), const Offset(150, 268), seam);
    // Visible ears, quietly at rest. No glow, recording waves or capture indicator.
    for (final x in [94.0, 206.0]) {
      canvas.drawOval(
        Rect.fromCenter(center: Offset(x, 119), width: 21, height: 32),
        skin,
      );
      canvas.drawArc(
        Rect.fromCenter(center: Offset(x, 119), width: 9, height: 17),
        -1.6,
        3.2,
        false,
        Paint()
          ..color = const Color(0xffbd9d83)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.2
          ..strokeCap = StrokeCap.round,
      );
    }
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        const Rect.fromLTWH(95, 61, 110, 112),
        const Radius.circular(47),
      ),
      skin,
    );
    final hair = Paint()
      ..shader = const LinearGradient(
        colors: [Color(0xff304d4d), Color(0xff1e3436)],
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
      ).createShader(const Rect.fromLTWH(91, 48, 119, 60));
    final cap = Path()
      ..moveTo(96, 111)
      ..cubicTo(78, 69, 110, 47, 149, 49)
      ..cubicTo(184, 42, 215, 70, 205, 108)
      ..lineTo(197, 91)
      ..cubicTo(169, 99, 140, 79, 126, 79)
      ..quadraticBezierTo(109, 86, 101, 110)
      ..close();
    canvas.drawPath(cap, hair);
    canvas.drawPath(
      Path()
        ..moveTo(139, 57)
        ..quadraticBezierTo(158, 45, 178, 57),
      Paint()
        ..color = const Color(0xff52716c)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3
        ..strokeCap = StrokeCap.round,
    );
    final ink = Paint()
      ..color = const Color(0xff294442)
      ..strokeCap = StrokeCap.round;
    final blink = phase > .955;
    for (final x in [130.0, 170.0]) {
      if (blink) {
        canvas.drawLine(
          Offset(x - 5, 120),
          Offset(x + 5, 120),
          ink..strokeWidth = 2.8,
        );
      } else {
        canvas.drawOval(
          Rect.fromCenter(center: Offset(x, 119), width: 10, height: 14),
          ink,
        );
        canvas.drawCircle(
          Offset(x + 1.5, 116.5),
          1.8,
          Paint()..color = const Color(0xfff7f6ef),
        );
      }
      canvas.drawArc(
        Rect.fromCenter(center: Offset(x, 105), width: 14, height: 6),
        3.5,
        2.3,
        false,
        Paint()
          ..color = const Color(0xff5b6660)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..strokeCap = StrokeCap.round,
      );
    }
    canvas.drawPath(
      Path()
        ..moveTo(150, 123)
        ..quadraticBezierTo(146, 133, 152, 132),
      Paint()
        ..color = const Color(0xffc29e81)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..strokeCap = StrokeCap.round,
    );
    if (speaking) {
      canvas.drawOval(
        Rect.fromCenter(
          center: const Offset(150, 141),
          width: 15,
          height: 5 + 6 * (1 + math.sin(phase * math.pi * 24)) / 2,
        ),
        Paint()..color = const Color(0xff7b675a),
      );
    } else {
      canvas.drawArc(
        const Rect.fromLTWH(140, 134, 20, 14),
        .25,
        2.64,
        false,
        Paint()
          ..color = const Color(0xff7b675a)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.2
          ..strokeCap = StrokeCap.round,
      );
    }
    for (final x in [114.0, 186.0]) {
      canvas.drawOval(
        Rect.fromCenter(center: Offset(x, 135), width: 14, height: 7),
        Paint()..color = const Color(0x35d98b77),
      );
    }
    canvas.restore();
    canvas.restore();
  }

  @override
  bool shouldRepaint(StandInPainter old) =>
      old.phase != phase || old.speaking != speaking;
}
