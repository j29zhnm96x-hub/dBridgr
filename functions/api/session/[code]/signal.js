import {
  cleanupEndedSessions,
  enqueueSignal,
  expireSessionIfNeeded,
  fetchSession,
  getDb,
  getRole,
  handleOptions,
  jsonResponse,
} from '../../../_lib/signaling-store.js';

export const onRequestOptions = handleOptions;

export async function onRequestPost(context) {
  try {
    const db = getDb(context.env);
    await cleanupEndedSessions(db);

    const body = await context.request.json().catch(() => null);
    if (!body?.clientId || !body?.type) {
      return jsonResponse({ error: 'Invalid JSON payload' }, 400);
    }

    let session = await fetchSession(db, context.params.code);
    session = await expireSessionIfNeeded(db, session);
    if (!session) {
      return jsonResponse({ error: 'Code not found or expired' }, 404);
    }

    const role = getRole(session, body.clientId);
    if (!role) {
      return jsonResponse({ error: 'Unknown client' }, 403);
    }
    if (session.ended_at) {
      return jsonResponse({ error: 'This bridge has already ended.' }, 410);
    }

    await enqueueSignal(db, context.params.code, role, body.type, body.data);
    return jsonResponse({ ok: true }, 202);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Could not send the signaling message.',
    }, 500);
  }
}