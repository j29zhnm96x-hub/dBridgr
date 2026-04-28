import {
  cleanupEndedSessions,
  createSession,
  getDb,
  handleOptions,
  jsonResponse,
} from '../../_lib/signaling-store.js';

export const onRequestOptions = handleOptions;

export async function onRequestPost(context) {
  try {
    const db = getDb(context.env);
    await cleanupEndedSessions(db);
    const session = await createSession(db);
    return jsonResponse(session, 201);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Could not create a new bridge.',
    }, 500);
  }
}