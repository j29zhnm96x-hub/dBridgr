const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');

const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.SMOKE_PORT || 18787);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function formatServerError(output, message) {
  const details = output.trim() ? `\n\nServer output:\n${output.trim()}` : '';
  return new Error(`${message}${details}`);
}

async function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const append = (chunk) => {
    output += chunk.toString();
  };

  child.stdout.on('data', append);
  child.stderr.on('data', append);

  const started = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(formatServerError(output, `Timed out waiting for server startup on port ${PORT}.`));
    }, 10000);

    const onData = (chunk) => {
      append(chunk);
      if (output.includes('dBridgr server listening on')) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        child.off('exit', onExit);
        resolve();
      }
    };

    const onExit = (code, signal) => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      reject(
        formatServerError(
          output,
          `Server exited before startup (code=${code}, signal=${signal || 'none'}).`
        )
      );
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });

  await started;
  return { child, getOutput: () => output };
}

async function stopServer(child) {
  if (!child || child.killed) {
    return;
  }

  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve());
  });

  child.kill();
  await Promise.race([exited, wait(2000)]);
}

async function requestJson(pathname, { method = 'GET', body, expectedStatus } = {}) {
  const response = await fetch(new URL(pathname, BASE_URL), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (typeof expectedStatus === 'number') {
    assert.equal(response.status, expectedStatus, `Expected status ${expectedStatus} for ${method} ${pathname}`);
  } else {
    assert.ok(response.ok, `Expected ${method} ${pathname} to succeed, got ${response.status}`);
  }

  return { status: response.status, payload };
}

async function requestText(pathname) {
  const response = await fetch(new URL(pathname, BASE_URL));
  const text = await response.text();
  assert.equal(response.status, 200, `Expected GET ${pathname} to return 200`);
  return text;
}

async function run() {
  const { child, getOutput } = await startServer();

  try {
    const indexHtml = await requestText('/');
    assert.ok(indexHtml.includes('dBridgr'), 'Index page should contain app title');

    const create = await requestJson('/api/session', {
      method: 'POST',
      body: {},
      expectedStatus: 201,
    });

    const hostSession = create.payload;
    assert.match(hostSession.code, /^\d{4}$/);
    assert.ok(hostSession.clientId, 'Create session should return host clientId');

    const initialHostEvents = await requestJson(
      `/api/session/${hostSession.code}/events?clientId=${encodeURIComponent(hostSession.clientId)}&cursor=0`
    );

    const initialPeerState = initialHostEvents.payload.events.find((event) => event.type === 'peer-state');
    assert.ok(initialPeerState, 'Initial poll should include peer-state');
    assert.equal(initialPeerState.guestPresent, false);

    const join = await requestJson(`/api/session/${hostSession.code}/join`, {
      method: 'POST',
      body: {},
      expectedStatus: 200,
    });

    const guestSession = join.payload;
    assert.ok(guestSession.clientId, 'Join should return guest clientId');

    const hostEventsAfterJoin = await requestJson(
      `/api/session/${hostSession.code}/events?clientId=${encodeURIComponent(hostSession.clientId)}&cursor=${initialHostEvents.payload.cursor}`
    );

    const hostPeerStateAfterJoin = hostEventsAfterJoin.payload.events.find((event) => event.type === 'peer-state');
    assert.ok(hostPeerStateAfterJoin, 'Host should still receive peer-state after join');
    assert.equal(hostPeerStateAfterJoin.guestPresent, true);

    await requestJson(`/api/session/${hostSession.code}/signal`, {
      method: 'POST',
      body: {
        clientId: hostSession.clientId,
        type: 'offer',
        data: {
          type: 'offer',
          sdp: 'smoke-offer',
        },
      },
      expectedStatus: 202,
    });

    const guestEvents = await requestJson(
      `/api/session/${hostSession.code}/events?clientId=${encodeURIComponent(guestSession.clientId)}&cursor=0`
    );

    const guestOffer = guestEvents.payload.events.find((event) => event.type === 'offer');
    assert.ok(guestOffer, 'Guest should receive offer event');
    assert.equal(guestOffer.from, 'host');

    await requestJson(`/api/session/${hostSession.code}`, {
      method: 'DELETE',
      body: { clientId: hostSession.clientId },
      expectedStatus: 200,
    });

    const guestEventsAfterDelete = await requestJson(
      `/api/session/${hostSession.code}/events?clientId=${encodeURIComponent(guestSession.clientId)}&cursor=${guestEvents.payload.cursor}`
    );

    const ended = guestEventsAfterDelete.payload.events.find((event) => event.type === 'session-ended');
    assert.ok(ended, 'Guest should receive session-ended after host disconnects');

    console.log('Smoke test passed: session create/join/signal/events/delete flow is healthy.');
  } catch (error) {
    throw formatServerError(getOutput(), error instanceof Error ? error.message : String(error));
  } finally {
    await stopServer(child);
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
