import {
  cleanupEndedSessions,
  collectEvents,
  expireSessionIfNeeded,
  fetchSession,
  getDb,
  getRole,
  handleOptions,
  jsonResponse,
  peerStateEvent,
  pollRetryMs,
  touchClient,
} from '../../../_lib/signaling-store.js';

export const onRequestOptions = handleOptions;

export async function onRequestGet(context) {
  try {
    const db = getDb(context.env);
    await cleanupEndedSessions(db);

    const url = new URL(context.request.url);
    const clientId = url.searchParams.get('clientId');
    const cursor = Number.parseInt(url.searchParams.get('cursor') || '0', 10);

    if (!clientId) {
      return jsonResponse({ error: 'Unknown client' }, 403);
    }

    let session = await fetchSession(db, context.params.code);
    session = await expireSessionIfNeeded(db, session);
    if (!session) {
      return jsonResponse({ error: 'Code not found or expired' }, 404);
    }

    const role = getRole(session, clientId);
    if (!role) {
      return jsonResponse({ error: 'Unknown client' }, 403);
    }

    const now = Date.now();
    await touchClient(db, context.params.code, role, now);
    const eventPayload = await collectEvents(db, context.params.code, role, Number.isFinite(cursor) ? cursor : 0, now);

    return jsonResponse({
      cursor: eventPayload.cursor,
      retryAfterMs: pollRetryMs(),
      events: [peerStateEvent(session, now, role), ...eventPayload.events],
    });
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Could not read bridge events.',
    }, 500);
  }
}