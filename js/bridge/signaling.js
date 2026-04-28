function resolveBaseUrl(explicitBaseUrl) {
  return explicitBaseUrl || window.__DBRIDGR_SIGNALING_URL__ || window.location.origin;
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, resolveBaseUrl(baseUrl)), {
    ...options,
    cache: 'no-store',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}.`);
  }
  return payload;
}

export class SignalingClient extends EventTarget {
  constructor(baseUrl) {
    super();
    this.baseUrl = resolveBaseUrl(baseUrl);
    this.pollController = null;
    this.pollGeneration = 0;
    this.cursor = 0;
    this.lastStreamErrorAt = 0;
  }

  async createSession() {
    return requestJson(this.baseUrl, '/api/session', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async joinSession(code) {
    return requestJson(this.baseUrl, `/api/session/${code}/join`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  connectStream({ code, clientId }) {
    this.close();
    this.cursor = 0;
    this.pollGeneration += 1;
    this.pollController = new AbortController();
    void this.pollLoop({
      code,
      clientId,
      generation: this.pollGeneration,
      signal: this.pollController.signal,
    });
  }

  async pollLoop({ code, clientId, generation, signal }) {
    let backoffMs = 500;

    while (!signal.aborted && generation === this.pollGeneration) {
      try {
        const payload = await requestJson(
          this.baseUrl,
          `/api/session/${code}/events?clientId=${encodeURIComponent(clientId)}&cursor=${this.cursor}`,
          {
            method: 'GET',
            signal,
          }
        );

        if (signal.aborted || generation !== this.pollGeneration) {
          return;
        }

        backoffMs = 900;
        if (typeof payload.cursor === 'number' && payload.cursor >= this.cursor) {
          this.cursor = payload.cursor;
        }

        for (const event of payload.events || []) {
          this.dispatchEvent(new CustomEvent('message', { detail: event }));
        }

        await wait(payload.retryAfterMs ?? 500);
      } catch (error) {
        if (signal.aborted || generation !== this.pollGeneration) {
          return;
        }

        const now = Date.now();
        if (now - this.lastStreamErrorAt > 4000) {
          this.lastStreamErrorAt = now;
          this.dispatchEvent(new CustomEvent('stream-error', {
            detail: {
              message: error instanceof Error ? error.message : 'Signaling stream interrupted.',
            },
          }));
        }

        await wait(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 4000);
      }
    }
  }

  async send(code, clientId, type, data) {
    return requestJson(this.baseUrl, `/api/session/${code}/signal`, {
      method: 'POST',
      body: JSON.stringify({ clientId, type, data }),
    });
  }

  async deleteSession(code, clientId) {
    return requestJson(this.baseUrl, `/api/session/${code}`, {
      method: 'DELETE',
      body: JSON.stringify({ clientId }),
    });
  }

  close() {
    this.pollGeneration += 1;
    if (this.pollController) {
      this.pollController.abort();
      this.pollController = null;
    }
  }
}