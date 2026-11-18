import 'package:material_ui/material_ui.dart';

import 'dish_contract.dart';

export 'dish_contract.dart';

typedef DishCommand = void Function(String kind, {String? direction});

/// An explicitly requested presentation, not a home screen or playback driver.
/// No network images and no command capable of confirming a physical stop.
class DishSurface extends StatelessWidget {
  const DishSurface({super.key, required this.view, required this.onCommand});
  final DishView view;
  final DishCommand onCommand;

  @override
  Widget build(BuildContext context) {
    if (view.view == 'none') return const SizedBox.shrink();
    final image = view.view == 'image';
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            view.name!,
            key: const Key('dish-name'),
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const Text('合成演示 · 非真实菜单或菜图'),
          if (!image)
            Text(
              view.description ?? '暂无菜品说明',
              key: const Key('dish-description'),
            ),
          if (image) ...[
            ClipRect(
              child: SizedBox(
                height: 200,
                width: double.infinity,
                child: Semantics(
                  label: '本地合成汤碗插画，非真实菜图',
                  image: true,
                  child: Transform.scale(
                    scale: view.zoomPermille / 1000,
                    child: CustomPaint(
                      key: const Key('dish-synthetic-image'),
                      painter: _SoupPainter(),
                    ),
                  ),
                ),
              ),
            ),
            Text(
              '缩放 ${(view.zoomPermille / 10).toStringAsFixed(0)}%',
              key: const Key('dish-zoom'),
            ),
          ],
          Wrap(
            spacing: 8,
            children: [
              if (!image && view.imageRef != null)
                TextButton(
                  onPressed: () => onCommand('image'),
                  child: const Text('查看合成插画'),
                ),
              if (image) ...[
                TextButton(
                  onPressed: () => onCommand('details'),
                  child: const Text('菜品说明'),
                ),
                TextButton(
                  key: const Key('dish-zoom-in'),
                  onPressed: view.zoomPermille < 3000
                      ? () => onCommand('zoom', direction: 'in')
                      : null,
                  child: const Text('放大'),
                ),
                TextButton(
                  key: const Key('dish-zoom-out'),
                  onPressed: view.zoomPermille > 1000
                      ? () => onCommand('zoom', direction: 'out')
                      : null,
                  child: const Text('缩小'),
                ),
              ],
              TextButton(
                onPressed: () => onCommand('hide'),
                child: const Text('收起'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SoupPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final cx = size.width / 2;
    final radius = size.width < 250 ? size.width * .32 : 80.0;
    final bowl = Rect.fromCenter(
      center: Offset(cx, 115),
      width: radius * 2,
      height: 70,
    );
    canvas.drawOval(bowl, Paint()..color = const Color(0xff547c99));
    canvas.drawOval(
      Rect.fromCenter(center: Offset(cx, 98), width: radius * 2, height: 40),
      Paint()..color = const Color(0xfff1ce81),
    );
    for (final dx in [-.4, .1, .45]) {
      canvas.drawCircle(
        Offset(cx + radius * dx, 97 + dx * 12),
        5,
        Paint()..color = const Color(0xff629868),
      );
    }
    final steam = Paint()
      ..color = const Color(0xff8698a5)
      ..strokeWidth = 3
      ..style = PaintingStyle.stroke;
    for (final dx in [-25.0, 0.0, 25.0]) {
      canvas.drawPath(
        Path()
          ..moveTo(cx + dx, 70)
          ..quadraticBezierTo(cx + dx - 12, 57, cx + dx, 42),
        steam,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _SoupPainter oldDelegate) => false;
}
