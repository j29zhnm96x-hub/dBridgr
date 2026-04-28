const SESSION_TTL_MS = 5 * 60 * 1000;
const SESSION_END_GRACE_MS = 60 * 1000;
const STREAM_ACTIVITY_TTL_MS = 15 * 1000;
const POLL_RETRY_MS = 900;
const DB_BINDING = 'DBRIDGR_DB';

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
    }),
  });
}

export function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export function getDb(env) {
  if (!env?.[DB_BINDING]) {
    throw new Error('Missing Cloudflare D1 binding `DBRIDGR_DB`. Add it to your Pages project and redeploy.');
  }
  return env[DB_BINDING];
}

export function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function createClientId() {
  return crypto.randomUUID();
}

export async function cleanupEndedSessions(db, now = Date.now()) {
  const cutoff = now - SESSION_END_GRACE_MS;
  await db.batch([
    db.prepare('DELETE FROM messages WHERE code IN (SELECT code FROM sessions WHERE ended_at IS NOT NULL AND ended_at <= ?)').bind(cutoff),
    db.prepare('DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at <= ?').bind(cutoff),
    db.prepare('DELETE FROM messages WHERE code IN (SELECT code FROM sessions WHERE guest_client_id IS NULL AND expires_at IS NOT NULL AND expires_at <= ? AND ended_at IS NULL)').bind(now - SESSION_TTL_MS),
    db.prepare('DELETE FROM sessions WHERE guest_client_id IS NULL AND expires_at IS NOT NULL AND expires_at <= ? AND ended_at IS NULL').bind(now - SESSION_TTL_MS),
  ]);
}

export async function fetchSession(db, code) {
  return db.prepare(
    `SELECT
      code,
      session_id,
      created_at,
      updated_at,
      expires_at,
      ended_at,
      host_client_id,
      host_last_seen_at,
      guest_client_id,
      guest_last_seen_at
    FROM sessions
    WHERE code = ?`
  ).bind(code).first();
}

export function getRole(session, clientId) {
  if (!session || !clientId) {
    return null;
  }
  if (session.host_client_id === clientId) {
    return 'host';
  }
  if (session.guest_client_id === clientId) {
    return 'guest';
  }
  return null;
}

export function isConnected(lastSeenAt, now = Date.now()) {
  return Boolean(lastSeenAt && now - lastSeenAt <= STREAM_ACTIVITY_TTL_MS);
}

export function peerStateEvent(session, now = Date.now(), role = null) {
  const hostLastSeenAt = role === 'host' ? now : session.host_last_seen_at;
  const guestLastSeenAt = role === 'guest' ? now : session.guest_last_seen_at;

  return {
    type: 'peer-state',
    hostPresent: Boolean(session.host_client_id),
    guestPresent: Boolean(session.guest_client_id),
    hostConnected: isConnected(hostLastSeenAt, now),
    guestConnected: isConnected(guestLastSeenAt, now),
    expiresAt: session.expires_at,
  };
}

export async function expireSessionIfNeeded(db, session, now = Date.now()) {
  if (!session || session.ended_at || !session.expires_at || session.guest_client_id) {
    return session;
  }

  if (session.expires_at > now) {
    return session;
  }

  await markSessionEnded(db, session.code, 'server', 'expired', now);
  return fetchSession(db, session.code);
}

export async function markSessionEnded(db, code, by, reason, now = Date.now()) {
  await db.prepare(
    `UPDATE sessions
      SET ended_at = COALESCE(ended_at, ?),
          expires_at = NULL,
          updated_at = ?
      WHERE code = ?`
  ).bind(now, now, code).run();

  const payload = JSON.stringify({ reason });
  await db.batch([
    db.prepare(
      'INSERT INTO messages (code, target_role, type, from_role, data, sent_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(code, 'host', 'session-ended', by, payload, now),
    db.prepare(
      'INSERT INTO messages (code, target_role, type, from_role, data, sent_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(code, 'guest', 'session-ended', by, payload, now),
  ]);
}

export async function createSession(db) {
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = generateCode();
    const sessionId = crypto.randomUUID();
    const clientId = createClientId();

    try {
      await db.prepare(
        `INSERT INTO sessions (
          code,
          session_id,
          created_at,
          updated_at,
          expires_at,
          host_client_id,
          host_last_seen_at,
          guest_client_id,
          guest_last_seen_at,
          ended_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0, NULL)`
      ).bind(code, sessionId, now, now, expiresAt, clientId).run();

      return {
        code,
        sessionId,
        clientId,
        expiresAt,
      };
    } catch (error) {
      if (!String(error?.message || '').includes('UNIQUE')) {
        throw error;
      }
    }
  }

  throw new Error('Could not allocate a free 4-digit code. Try again.');
}

export async function joinSession(db, code) {
  const now = Date.now();
  const clientId = createClientId();

  const updated = await db.prepare(
    `UPDATE sessions
      SET guest_client_id = ?,
          guest_last_seen_at = 0,
          expires_at = NULL,
          updated_at = ?
      WHERE code = ?
        AND guest_client_id IS NULL
        AND ended_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`
  ).bind(clientId, now, code, now).run();

  if (!updated.meta?.changes) {
    const session = await fetchSession(db, code);
    if (!session || (session.expires_at && session.expires_at <= now) || session.ended_at) {
      return { error: 'Code not found or expired', status: 404 };
    }
    return { error: 'Session is already paired', status: 409 };
  }

  const session = await fetchSession(db, code);
  return {
    code,
    sessionId: session.session_id,
    clientId,
    expiresAt: session.expires_at,
  };
}

export async function touchClient(db, code, role, now = Date.now()) {
  const column = role === 'host' ? 'host_last_seen_at' : 'guest_last_seen_at';
  await db.prepare(
    `UPDATE sessions
      SET ${column} = ?, updated_at = ?
      WHERE code = ?`
  ).bind(now, now, code).run();
}

export async function collectEvents(db, code, role, cursor, now = Date.now()) {
  const rows = await db.prepare(
    `SELECT id, type, from_role, data, sent_at
      FROM messages
      WHERE code = ? AND target_role = ? AND id > ?
      ORDER BY id ASC
      LIMIT 64`
  ).bind(code, role, cursor).all();

  const results = rows.results || [];
  const nextCursor = results.length ? results[results.length - 1].id : cursor;

  return {
    cursor: nextCursor,
    events: results.map((row) => {
      let data = null;
      if (row.data) {
        try {
          data = JSON.parse(row.data);
        } catch {
          data = row.data;
        }
      }

      if (row.type === 'session-ended') {
        return {
          type: row.type,
          by: row.from_role,
          reason: data?.reason || 'disconnect',
          sentAt: row.sent_at,
        };
      }

      return {
        type: row.type,
        data,
        from: row.from_role,
        sentAt: row.sent_at,
      };
    }),
  };
}

export async function enqueueSignal(db, code, role, type, data, now = Date.now()) {
  const targetRole = role === 'host' ? 'guest' : 'host';
  await db.prepare(
    'INSERT INTO messages (code, target_role, type, from_role, data, sent_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(code, targetRole, type, role, JSON.stringify(data ?? null), now).run();
}

export function pollRetryMs() {
  return POLL_RETRY_MS;
}