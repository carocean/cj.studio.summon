import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:material_ui/material_ui.dart';
import 'package:summon_app/preview_app.dart';
import 'package:summon_app/protected_preview_client.dart';
import 'package:summon_app/scene_experiment.dart';
import 'package:summon_app/creature_home.dart';
import 'package:summon_app/temporary_interaction.dart';

import 'creature_home_minimal_test.dart' as home;
import 'temporary_interaction_test.dart' as temp;
import 'protected_preview_client_test.dart' show Sending;

const token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
http.Response json(Object? v, [int status = 200]) => http.Response(
  jsonEncode(v),
  status,
  headers: {'content-type': 'application/json'},
);

class AuthHost {
  bool authenticated = true, rejectEdit = false;
  String csrfToken = token;
  final calls = <http.Request>[];
  final view = temp.fixture();
  Completer<http.Response>? holdLogin;
  PreviewSessionClient client({void Function()? openLogin}) =>
      PreviewSessionClient.forTesting(
        origin: Uri.parse('https://preview.example'),
        openLogin: openLogin,
        clientFactory: () => MockClient(handle),
      );
  Future<http.Response> handle(http.Request r) async {
    calls.add(r);
    expect(r.url.origin, 'https://preview.example');
    expect(r.followRedirects, false);
    final action = r.url.path.split('/').last;
    if (action == 'login') {
      if (holdLogin != null) return holdLogin!.future;
      authenticated = true;
      return json({'csrf': csrfToken, 'expiresInMs': 300000});
    }
    if (action == 'session') {
      return authenticated
          ? json({'csrf': csrfToken, 'expiresInMs': 300000})
          : json({'error': 'authentication_required'}, 401);
    }
    if (action == 'logout') {
      authenticated = false;
      return json({'loggedOut': true});
    }
    if (!authenticated || (rejectEdit && action == 'interaction-edit')) {
      authenticated = false;
      return json({'error': 'authentication_required'}, 401);
    }
    if (r.method == 'POST' &&
        r.url.path.startsWith('/scene/') &&
        r.headers['X-Preview-CSRF'] != csrfToken) {
      return json({'error': 'csrf_required'}, 403);
    }
    if (action == 'state') return json(home.state());
    if (action == 'usage') {
      return json({
        'schema': 'real-usage-history.v1',
        'items': [],
        'sourceTrust': 'host-actions-and-client-presentation-reports',
        'minUses': 2,
        'learningSaturated': false,
      });
    }
    if (action == 'interaction-current') {
      return json({'sessionId': view['sessionId'], 'context': view['context']});
    }
    if (action == 'interaction-read') return json(view);
    if (action == 'interaction-query') {
      return json({
        'commandId': jsonDecode(r.body)['commandId'],
        'status': 'not_started',
      });
    }
    return json({'error': 'not_expected'}, 400);
  }
}

void main() {
  test('cold init only session read; no arbitrary login route; cancellation ignores late result', () async {
    final host = AuthHost()..authenticated = false;
    var opens = 0;
    final client = host.client(openLogin: () => opens++);
    await client.initialize();
    expect(client.access.value, false);
    expect(host.calls.length, 1);
    client.openColdLogin();
    expect(opens, 1);
    final hold = host.holdLogin = Completer<http.Response>();
    final login = client.login(token);
    await Future<void>.delayed(const Duration(milliseconds: 5));
    client.cancelAuthentication();
    await login;
    hold.complete(json({'csrf': token, 'expiresInMs': 300000}));
    await Future<void>.delayed(const Duration(milliseconds: 5));
    expect(client.access.value, false);
    expect(host.calls.length, 2);
    host.holdLogin = null;
    await client.login(token);
    expect(client.access.value, true);
    client.openColdLogin();
    expect(opens, 1);
    client.cancelAuthentication();
    expect(client.access.value, true);
    expect(host.calls.where((r) => r.url.path.startsWith('/scene/')), isEmpty);
    client.close();
  });
  test('401 stable proxy locks; login plus explicit check replaces transport without replay', () async {
    final host = AuthHost(), client = AuthHost().client();
    client.close();
    final stable = host.client();
    await stable.initialize();
    final api = SceneExperimentApi(stable);
    await api.request('usage');
    host.authenticated = false;
    await expectLater(
      api.request('interaction-query', {'commandId': 'old-command'}),
      throwsA(anything),
    );
    expect(stable.access.value, false);
    final writes = host.calls
        .where((r) => r.url.path.startsWith('/scene/'))
        .length;
    await stable.login(token);
    expect(stable.access.value, true);
    expect(
      host.calls.where((r) => r.url.path.startsWith('/scene/')).length,
      writes,
    );
    await api.request('interaction-query', {'commandId': 'old-command'});
    expect(jsonDecode(host.calls.last.body)['commandId'], 'old-command');
    await stable.logout();
    expect(stable.access.value, false);
    expect(
      host.calls.where((r) => r.url.path.endsWith('interaction-save')),
      isEmpty,
    );
    stable.close();
  });
  for (final pending in [false, true]) {
    testWidgets(
      'running 401 retains exact Home, dirty values and pending=$pending',
      (t) async {
        final host = AuthHost(), controller = CreatureHomeController();
        final session = host.client();
        await t.pumpWidget(
          PreviewApp(session: session, controller: controller),
        );
        await home.idle(t);
        final homeElement = find
            .byType(CreatureHome, skipOffstage: false)
            .evaluate()
            .single;
        expect(
          await controller.presentInteraction(host.view['sessionId']),
          CreaturePresentationResult.shown,
        );
        await home.idle(t);
        await t.enterText(
          find.byKey(const ValueKey('interaction-subject')),
          '😀界',
        );
        await home.idle(t);
        final draft = t
            .widget<TemporaryInteractionSheet>(
              find.byType(TemporaryInteractionSheet),
            )
            .recovery;
        if (pending) {
          host.rejectEdit = true;
          await temp.tap(t, 'interaction-update');
        } else {
          host.authenticated = false;
          await expectLater(
            SceneExperimentApi(session).request('usage'),
            throwsA(anything),
          );
          await home.idle(t);
        }
        expect(session.access.value, false);
        expect(draft.values['subject'], '😀界');
        expect(
          t
              .widget<TextField>(
                find.byKey(const ValueKey('interaction-subject')),
              )
              .readOnly,
          true,
        );
        final command = draft.pending?['body']['commandId'];
        if (pending) expect(command, isNotNull);
        await temp.tap(t, 'preview-reauth');
        await t.enterText(find.byKey(const Key('preview-invitation')), token);
        await temp.tap(t, 'preview-auth-cancel');
        expect(find.byKey(const Key('preview-invitation')), findsNothing);
        expect(session.access.value, false);
        expect(draft.values['subject'], '😀界');
        expect(
          host.calls.where((r) => r.url.path == '/preview/login'),
          isEmpty,
        );
        await temp.tap(t, 'preview-reauth');
        expect(
          t
              .widget<TextField>(find.byKey(const Key('preview-invitation')))
              .controller!
              .text,
          isEmpty,
        );
        await t.enterText(find.byKey(const Key('preview-invitation')), token);
        await temp.tap(t, 'preview-login-submit');
        expect(session.access.value, true);
        expect(
          find.byType(CreatureHome, skipOffstage: false).evaluate().single,
          same(homeElement),
        );
        expect(draft.values['subject'], '😀界');
        expect(
          host.calls.where((r) => r.url.path.endsWith('interaction-save')),
          isEmpty,
        );
        if (pending) {
          expect(draft.pending?['body']['commandId'], command);
          await temp.tap(t, 'interaction-query');
          final q = host.calls.lastWhere(
            (r) => r.url.path.endsWith('interaction-query'),
          );
          expect(jsonDecode(q.body)['commandId'], command);
          expect(
            host.calls
                .where((r) => r.url.path.endsWith('interaction-edit'))
                .length,
            1,
          );
        } else {
          expect(
            t
                .widget<TextField>(
                  find.byKey(const ValueKey('interaction-subject')),
                )
                .readOnly,
            true,
          );
          await temp.tap(t, 'interaction-revalidate');
          expect(draft.values['subject'], '😀界');
          expect(
            t
                .widget<TextField>(
                  find.byKey(const ValueKey('interaction-subject')),
                )
                .readOnly,
            false,
          );
        }
        await temp.tap(t, 'preview-options');
        await temp.tap(t, 'preview-logout');
        expect(find.textContaining('有未保存输入或结果未知'), findsOneWidget);
        await temp.tap(t, 'preview-confirm-logout');
        expect(draft.values['subject'], '😀界');
        expect(session.access.value, false);
        await t.pumpWidget(const SizedBox());
      },
    );
  }
  test('new cookie and old CSRF locks only csrf_required; explicit session check does not replay', () async {
    final host = AuthHost(), session = AuthHost().client();
    session.close();
    final client = host.client();
    await client.initialize();
    host.csrfToken = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await expectLater(
      SceneExperimentApi(client)
          .request('interaction-query', {'commandId': 'original'}),
      throwsA(anything),
    );
    expect(client.access.value, false);
    final count = host.calls
        .where((r) => r.url.path.startsWith('/scene/'))
        .length;
    await client.checkSession();
    expect(client.access.value, true);
    expect(
      host.calls.where((r) => r.url.path.startsWith('/scene/')).length,
      count,
    );
    await SceneExperimentApi(client)
        .request('interaction-query', {'commandId': 'original'});
    expect(host.calls.last.headers['X-Preview-CSRF'], host.csrfToken);
    client.close();
  });
  for (final status in [401, 403]) {
    test(
      'old $status cannot reach UI after new authentication epoch',
      () async {
        final body = StreamController<List<int>>();
        Future<void>? renewed;
        late PreviewSessionClient session;
        var renewOnLock = false;
        session = PreviewSessionClient.forTesting(
          origin: Uri.parse('https://preview.example'),
          clientFactory: () => Sending((r) async {
            if (r.url.path.startsWith('/preview/')) {
              return http.StreamedResponse(
                Stream.value(
                  utf8.encode(
                    jsonEncode({'csrf': token, 'expiresInMs': 300000}),
                  ),
                ),
                200,
                headers: {'content-type': 'application/json'},
              );
            }
            return http.StreamedResponse(
              body.stream,
              status,
              headers: {'content-type': 'application/json'},
            );
          }),
        );
        await session.initialize();
        session.access.addListener(() {
          if (!session.access.value && renewOnLock) {
            renewOnLock = false;
            renewed = session.login(token);
          }
        });
        renewOnLock = true;
        final old = SceneExperimentApi(session)
            .request('interaction-query', {'commandId': 'original'});
        final check = expectLater(
          old,
          throwsA(isA<http.RequestAbortedException>()),
        );
        if (status == 401) {
          await Future<void>.delayed(const Duration(milliseconds: 5));
          await renewed;
          expect(session.access.value, true);
        }
        body.add(
          utf8.encode(
            status == 401
                ? '{"error":"authentication_required"}'
                : '{"error":"csrf_required"}',
          ),
        );
        await body.close();
        await check;
        await renewed;
        expect(session.access.value, true);
        session.close();
      },
    );
  }
  test('ordinary 403 does not retire authenticated transport', () async {
    final session = PreviewSessionClient.forTesting(
      origin: Uri.parse('https://preview.example'),
      clientFactory: () => MockClient(
        (r) async => r.url.path == '/preview/session'
            ? json({'csrf': token, 'expiresInMs': 300000})
            : json({'error': 'outside_context'}, 403),
      ),
    );
    await session.initialize();
    await expectLater(
      SceneExperimentApi(session)
          .request('interaction-query', {'commandId': 'original'}),
      throwsA(anything),
    );
    expect(session.access.value, true);
    session.close();
  });
  testWidgets('preview unknown route never opens local workbench', (t) async {
    final host = AuthHost();
    final session = host.client();
    await t.pumpWidget(PreviewApp(session: session));
    await home.idle(t);
    unawaited(
      Navigator.of(t.element(find.byType(CreatureHome)))
          .pushNamed('/workbench'),
    );
    await t.pumpAndSettle();
    expect(find.text('此预览不开放开发路由。'), findsOneWidget);
    expect(find.text('http://127.0.0.1:8080'), findsNothing);
    expect(
      host.calls.every((r) => r.url.origin == 'https://preview.example'),
      true,
    );
    await t.pumpWidget(const SizedBox());
  });
}
