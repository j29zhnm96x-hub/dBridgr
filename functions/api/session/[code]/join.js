import {
  cleanupEndedSessions,
  getDb,
  handleOptions,
  joinSession,
  jsonResponse,
} from '../../../_lib/signaling-store.js';

export const onRequestOptions = handleOptions;

export async function onRequestPost(context) {
  try {
    const db = getDb(context.env);
    await cleanupEndedSessions(db);
    const result = await joinSession(db, context.params.code);
    if (result.error) {
      return jsonResponse({ error: result.error }, result.status);
    }
    return jsonResponse(result, 200);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : 'Could not join that bridge.',
    }, 500);
  }
}