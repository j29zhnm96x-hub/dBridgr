function resolveBaseUrl(explicitBaseUrl) {
  return explicitBaseUrl || window.__DBRIDGR_SIGNALING_URL__ || window.location.origin;
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, resolveBaseUrl(baseUrl)), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
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
    this.eventSource = null;
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
    const endpoint = new URL(`/api/session/${code}/events`, this.baseUrl);
    endpoint.searchParams.set('clientId', clientId);

    this.eventSource = new EventSource(endpoint.toString());
    this.eventSource.onmessage = (event) => {
      if (!event.data) {
        return;
      }

      try {
        const payload = JSON.parse(event.data);
        this.dispatchEvent(new CustomEvent('message', { detail: payload }));
      } catch {
        this.dispatchEvent(new CustomEvent('stream-error', { detail: { message: 'Received malformed signaling data.' } }));
      }
    };

    this.eventSource.onerror = () => {
      this.dispatchEvent(new CustomEvent('stream-error', { detail: { message: 'Signaling stream interrupted.' } }));
    };
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
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}