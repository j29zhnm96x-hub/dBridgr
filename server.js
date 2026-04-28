const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 8787);
const ROOT_DIR = __dirname;
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/manifest.webmanifest', 'manifest.webmanifest'],
  ['/sw.js', 'sw.js'],
]);

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const NO_STORE_EXTENSIONS = new Set(['.css', '.html', '.js', '.svg', '.webmanifest']);

const SESSION_TTL_MS = 5 * 60 * 1000;
const SESSION_END_GRACE_MS = 60 * 1000;
const STREAM_ACTIVITY_TTL_MS = 15 * 1000;
const MAX_MESSAGE_BYTES = 256 * 1024;
const POLL_RETRY_MS = 900;
const MAX_EVENT_LOG_LENGTH = 256;
const sessions = new Map();

function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function notFound(response) {
  json(response, 404, { error: 'Not found' });
}

function generateCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function createSessionRecord(code) {
  const now = Date.now();
  return {
    code,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    endedAt: null,
    host: null,
    guest: null,
    nextEventId: 1,
    events: [],
  };
}

function isConnected(client) {
  return Boolean(client?.lastSeenAt && Date.now() - client.lastSeenAt <= STREAM_ACTIVITY_TTL_MS);
}

function appendEvent(session, targetRole, message) {
  session.events.push({
    id: session.nextEventId,
    targetRole,
    ...message,
  });
  session.nextEventId += 1;

  if (session.events.length > MAX_EVENT_LOG_LENGTH) {
    session.events.splice(0, session.events.length - MAX_EVENT_LOG_LENGTH);
  }
}

function appendEventForBoth(session, message) {
  appendEvent(session, 'host', message);
  appendEvent(session, 'guest', message);
}

function endSession(session, payload) {
  if (session.endedAt) {
    return;
  }

  session.endedAt = Date.now();
  session.expiresAt = null;
  session.updatedAt = session.endedAt;
  appendEventForBoth(session, payload);
}

function sweepExpiredSessions() {
  const now = Date.now();
  for (const [code, session] of sessions) {
    if (!session.endedAt && !session.guest && session.expiresAt && session.expiresAt <= now) {
      endSession(session, {
        type: 'session-ended',
        by: 'server',
        reason: 'expired',
      });
    }

    if (session.endedAt && now - session.endedAt > SESSION_END_GRACE_MS) {
      sessions.delete(code);
    }
  }
}

function getRole(session, clientId) {
  if (session.host?.clientId === clientId) {
    return 'host';
  }
  if (session.guest?.clientId === clientId) {
    return 'guest';
  }
  return null;
}

function ensureClient(session, role) {
  if (!session[role]) {
    session[role] = {
      clientId: crypto.randomUUID(),
      lastSeenAt: 0,
    };
  }
  return session[role];
}

function buildPeerState(session) {
  return {
    type: 'peer-state',
    hostPresent: Boolean(session.host),
    guestPresent: Boolean(session.guest),
    hostConnected: isConnected(session.host),
    guestConnected: isConnected(session.guest),
    expiresAt: session.expiresAt,
  };
}

function collectEvents(session, role, cursor) {
  const events = [buildPeerState(session)];
  let nextCursor = Number.isFinite(cursor) ? cursor : 0;

  for (const event of session.events) {
    if (event.targetRole !== role || event.id <= nextCursor) {
      continue;
    }

    nextCursor = event.id;
    events.push({
      type: event.type,
      data: event.data,
      from: event.from,
      by: event.by,
      reason: event.reason,
      sentAt: event.sentAt,
    });
  }

  return {
    cursor: nextCursor,
    events,
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_MESSAGE_BYTES) {
        reject(new Error('Request too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    request.on('error', reject);
  });
}

async function handleCreateSession(response) {
  sweepExpiredSessions();
  let code = generateCode();
  while (sessions.has(code)) {
    code = generateCode();
  }

  const session = createSessionRecord(code);
  const host = ensureClient(session, 'host');
  sessions.set(code, session);
  json(response, 201, {
    code,
    sessionId: session.id,
    clientId: host.clientId,
    expiresAt: session.expiresAt,
  });
}

async function handleJoinSession(code, response) {
  sweepExpiredSessions();
  const session = sessions.get(code);
  if (!session) {
    json(response, 404, { error: 'Code not found or expired' });
    return;
  }
  if (session.endedAt) {
    json(response, 410, { error: 'Code not found or expired' });
    return;
  }
  if (session.guest) {
    json(response, 409, { error: 'Session is already paired' });
    return;
  }
  const guest = ensureClient(session, 'guest');
  session.expiresAt = null;
  session.updatedAt = Date.now();
  json(response, 200, {
    code,
    sessionId: session.id,
    clientId: guest.clientId,
    expiresAt: session.expiresAt,
  });
}

async function handleEventPoll(code, url, response) {
  sweepExpiredSessions();
  const session = sessions.get(code);
  const clientId = url.searchParams.get('clientId');
  if (!session || !clientId) {
    notFound(response);
    return;
  }

  const role = getRole(session, clientId);
  if (!role) {
    json(response, 403, { error: 'Unknown client' });
    return;
  }

  const cursor = Number.parseInt(url.searchParams.get('cursor') || '0', 10);
  session[role].lastSeenAt = Date.now();
  session.updatedAt = session[role].lastSeenAt;

  const payload = collectEvents(session, role, cursor);
  json(response, 200, {
    ...payload,
    retryAfterMs: POLL_RETRY_MS,
  });
}

async function handleSignalPost(code, request, response) {
  sweepExpiredSessions();
  const session = sessions.get(code);
  if (!session) {
    json(response, 404, { error: 'Code not found or expired' });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readRequestBody(request));
  } catch {
    json(response, 400, { error: 'Invalid JSON payload' });
    return;
  }

  const { clientId, type, data } = body;
  const role = getRole(session, clientId);
  if (!role) {
    json(response, 403, { error: 'Unknown client' });
    return;
  }
  if (session.endedAt) {
    json(response, 410, { error: 'This bridge has already ended.' });
    return;
  }

  const targetRole = role === 'host' ? 'guest' : 'host';
  appendEvent(session, targetRole, {
    type,
    data,
    from: role,
    sentAt: Date.now(),
  });
  session.updatedAt = Date.now();
  json(response, 202, { ok: true });
}

async function handleDeleteSession(code, request, response) {
  const session = sessions.get(code);
  if (!session) {
    json(response, 204, { ok: true });
    return;
  }

  const bodyText = await readRequestBody(request).catch(() => '{}');
  const { clientId } = JSON.parse(bodyText || '{}');
  const role = clientId ? getRole(session, clientId) : null;
  if (clientId && !role) {
    json(response, 403, { error: 'Unknown client' });
    return;
  }

  endSession(session, { type: 'session-ended', by: role || 'server', reason: 'disconnect' });
  json(response, 200, { ok: true });
}

function serveStatic(requestPath, response) {
  const directPath = STATIC_FILES.get(requestPath) || requestPath.slice(1);
  const resolvedPath = path.resolve(ROOT_DIR, directPath);
  if (!resolvedPath.startsWith(ROOT_DIR)) {
    notFound(response);
    return;
  }

  fs.readFile(resolvedPath, (error, content) => {
    if (error) {
      notFound(response);
      return;
    }
    const extension = path.extname(resolvedPath);
    response.writeHead(200, {
      'Cache-Control': NO_STORE_EXTENSIONS.has(extension) ? 'no-store' : 'public, max-age=300',
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    });
    response.end();
    return;
  }

  if (request.method === 'POST' && pathname === '/api/session') {
    await handleCreateSession(response);
    return;
  }

  const joinMatch = pathname.match(/^\/api\/session\/(\d{4})\/join$/);
  if (request.method === 'POST' && joinMatch) {
    await handleJoinSession(joinMatch[1], response);
    return;
  }

  const signalMatch = pathname.match(/^\/api\/session\/(\d{4})\/signal$/);
  if (request.method === 'POST' && signalMatch) {
    await handleSignalPost(signalMatch[1], request, response);
    return;
  }

  const eventsMatch = pathname.match(/^\/api\/session\/(\d{4})\/events$/);
  if (request.method === 'GET' && eventsMatch) {
    await handleEventPoll(eventsMatch[1], url, response);
    return;
  }

  const deleteMatch = pathname.match(/^\/api\/session\/(\d{4})$/);
  if (request.method === 'DELETE' && deleteMatch) {
    await handleDeleteSession(deleteMatch[1], request, response);
    return;
  }

  serveStatic(pathname, response);
});

server.listen(PORT, () => {
  console.log(`dBridgr server listening on http://localhost:${PORT}`);
});

setInterval(sweepExpiredSessions, 30 * 1000).unref();