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
const MAX_MESSAGE_BYTES = 256 * 1024;
const sessions = new Map();

function emitEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

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
    expiresAt: now + SESSION_TTL_MS,
    host: null,
    guest: null,
    queues: {
      host: [],
      guest: [],
    },
  };
}

function endSession(session, payload) {
  enqueueFor(session, 'host', payload);
  enqueueFor(session, 'guest', payload);

  if (session.host?.stream) {
    flushQueue(session.host.stream, session, 'host');
  }
  if (session.guest?.stream) {
    flushQueue(session.guest.stream, session, 'guest');
  }

  sessions.delete(session.code);
}

function sweepExpiredSessions() {
  const now = Date.now();
  for (const [code, session] of sessions) {
    if (!session.guest && session.expiresAt && session.expiresAt <= now) {
      endSession(session, {
        type: 'session-ended',
        by: 'server',
        reason: 'expired',
      });
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
    session[role] = { clientId: crypto.randomUUID() };
  }
  return session[role];
}

function enqueueFor(session, role, message) {
  session.queues[role].push(message);
}

function flushQueue(response, session, role) {
  const queue = session.queues[role];
  emitEvent(response, { type: 'ready' });
  if (!queue.length) {
    return;
  }
  while (queue.length) {
    emitEvent(response, queue.shift());
  }
}

function broadcastPeerState(session) {
  const hostConnected = Boolean(session.host?.stream);
  const guestConnected = Boolean(session.guest?.stream);
  const payload = {
    type: 'peer-state',
    hostPresent: Boolean(session.host),
    guestPresent: Boolean(session.guest),
    hostConnected,
    guestConnected,
    expiresAt: session.expiresAt,
  };
  enqueueFor(session, 'host', payload);
  enqueueFor(session, 'guest', payload);
  session.host?.stream && flushQueue(session.host.stream, session, 'host');
  session.guest?.stream && flushQueue(session.guest.stream, session, 'guest');
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
  if (session.guest) {
    json(response, 409, { error: 'Session is already paired' });
    return;
  }
  const guest = ensureClient(session, 'guest');
  session.expiresAt = null;
  json(response, 200, {
    code,
    sessionId: session.id,
    clientId: guest.clientId,
    expiresAt: session.expiresAt,
  });
}

async function handleEventStream(code, url, request, response) {
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

  response.writeHead(200, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  });
  session[role].stream = response;
  flushQueue(response, session, role);
  broadcastPeerState(session);

  request.on('close', () => {
    if (session[role]?.stream === response) {
      session[role].stream = null;
      broadcastPeerState(session);
    }
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

  const targetRole = role === 'host' ? 'guest' : 'host';
  const message = {
    type,
    data,
    from: role,
    sentAt: Date.now(),
  };
  enqueueFor(session, targetRole, message);
  if (session[targetRole]?.stream) {
    flushQueue(session[targetRole].stream, session, targetRole);
  }
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
    await handleEventStream(eventsMatch[1], url, request, response);
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