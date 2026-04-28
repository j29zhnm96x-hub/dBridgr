function cloneState(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

export function createInitialState(theme = 'light') {
  return {
    screen: 'bridge',
    theme,
    activeComposer: 'text',
    joinSheetOpen: false,
    joinCode: '',
    connection: {
      status: 'idle',
      role: null,
      code: '',
      expiresAt: null,
      peerLabel: 'Waiting for pairing',
      peerNote: 'Bidirectional transfers become available after pairing.',
      note: 'Create a code on one device, then join it from the other device.',
      error: '',
      sessionHint: '',
    },
    composers: {
      text: {
        value: '',
      },
      photo: {
        file: null,
        previewUrl: '',
        warning: '',
        error: '',
      },
      video: {
        file: null,
        previewUrl: '',
        warning: '',
        error: '',
      },
      file: {
        file: null,
        warning: '',
        error: '',
      },
    },
    activeTransfers: [],
    receivedItems: [],
    notices: [],
    diagnostics: {
      online: true,
      standalone: false,
      serviceWorkerReady: false,
    },
  };
}

export function createStore(initialState) {
  let state = cloneState(initialState);
  const listeners = new Set();

  return {
    getState() {
      return state;
    },
    setState(nextState) {
      state = nextState;
      listeners.forEach((listener) => listener(state));
      return state;
    },
    update(updater) {
      const nextState = typeof updater === 'function' ? updater(state) : { ...state, ...updater };
      return this.setState(nextState);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}