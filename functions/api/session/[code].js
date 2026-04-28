import {
  cleanupEndedSessions,
  expireSessionIfNeeded,
  fetchSession,
  getDb,
  getRole,
  handleOptions,
  jsonResponse,
  markSessionEnded,
} from '../../_lib/signaling-store.js';

export const onRequestOptions = handleOptions;

export async function onRequestDelete(context) {
  try {
    const db = getDb(context.env);
    await cleanupEndedSessions(db);

    const body = await context.request.json().catch(() => ({}));
    let session = await fetchSession(db, context.params.code);
    session = await expireSessionIfNeeded(db, session);
    if (!session) {
      return jsonResponse({ ok: true }, 204);
    }

    const role = body.clientId ? getRole(session, body.clientId) : null;
    if (body.clientId && !role) {
      return jsonResponse({ error: 'Unknown client' }, 403);
    }

    await markSessionEnded(db, context.params.code, role || 'server', 'disconnect');
    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Could not end the bridge.',
    }, 500);
  }
}