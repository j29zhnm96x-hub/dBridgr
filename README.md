# dBridgr

dBridgr is a standalone-friendly mobile-first PWA for bridging text, photos, videos, and generic files directly between two devices.

The UI is plain HTML, CSS, and vanilla JavaScript ES modules. There is no framework and no build step.

## What it does

- Device A hosts a temporary bridge and gets a 4-digit code.
- Device B joins with that code.
- The two browsers negotiate a WebRTC DataChannel.
- After pairing, text and file bytes move peer-to-peer over the DataChannel.
- The signaling server is only used for offer, answer, ICE exchange, and temporary session lookup.

## Architecture

The app is intentionally split into small vanilla modules:

- `server.js`: tiny Node server that serves the static app and handles ephemeral signaling by 4-digit code.
- `js/bridge/signaling.js`: minimal signaling client abstraction.
- `js/bridge/transport.js`: WebRTC peer connection and DataChannel lifecycle.
- `js/bridge/protocol.js`: chunked transfer protocol with `start`, `chunk`, `complete`, `cancel`, and `error` semantics.
- `js/bridge/chunks.js`: chunk sizing, buffering, and large-file limits.
- `js/bridge/session.js`: bridge/session orchestration and connection state machine.
- `js/state/store.js`: local UI state store.
- `js/core/theme.js`, `js/core/storage.js`, `js/core/pwa.js`: persisted theme and PWA shell behavior.
- `js/app.js`: role-aware UI binding and rendering.

## Pairing model

This app does not fake an impossible static-only architecture.

Why the signaling layer exists:

- Browsers cannot create a robust same-Wi-Fi + 4-digit-code + WebRTC flow without some signaling path.
- dBridgr uses a tiny replaceable signaling service to map a 4-digit code to a temporary session.
- The signaling service does not proxy actual transferred text, media, or file bytes.

What is peer-to-peer:

- Text payloads.
- Photo bytes.
- Video bytes.
- Generic file bytes.

What is not peer-to-peer:

- Offer exchange.
- Answer exchange.
- ICE candidate exchange.
- Temporary session lookup for the 4-digit code.

## Connection states

The top connection card can show:

- `idle`
- `hosting`
- `joining`
- `connected`
- `reconnecting`
- `error`

## Transfer protocol

Binary content is chunked conservatively for mobile browsers.

- Control messages are JSON messages over the DataChannel.
- Chunk messages are binary DataChannel packets with a transfer id header.
- Each transfer is tracked independently on sender and receiver.
- DataChannel backpressure is respected through `bufferedAmount` thresholds.
- Large files trigger a warning.
- Very large files above the soft limit are blocked by default for reliability.

The main tuning values live in `js/bridge/chunks.js`.

## PWA behavior

- `manifest.webmanifest` defines the installable app shell.
- `sw.js` caches the shell only.
- Live signaling and live peer traffic are never cached by the service worker.
- Apple web-app meta tags and `apple-touch-icon` are included for iPhone home screen launches.

## Run locally

Requirements:

- Node.js 18+

Start the app:

```bash
npm start
```

Or:

```bash
node server.js
```

Then open:

```text
http://localhost:8787
```

For a real device test on the same Wi-Fi:

1. Start the server on your computer.
2. Find your computer's LAN IP.
3. Open `http://YOUR-LAN-IP:8787` on both devices.
4. Host on one device and join with the 4-digit code on the other.

## Deploy

### Simplest deployment

Deploy `server.js` on a small Node host and serve the static files from the same origin.

That is the cleanest path because the included client defaults to same-origin signaling.

### Static frontend plus separate signaling service

The frontend can be deployed statically, but it still needs a compatible signaling endpoint that implements the same API shape:

- `POST /api/session`
- `POST /api/session/:code/join`
- `GET /api/session/:code/events?clientId=...`
- `POST /api/session/:code/signal`
- `DELETE /api/session/:code`

If you separate the frontend from signaling, either:

1. reverse-proxy `/api/*` from the frontend origin to the signaling service, or
2. set `window.__DBRIDGR_SIGNALING_URL__` before `js/main.js` loads so the client targets the signaling origin.

## iPhone and browser caveats

These are real browser limits, not app bugs:

- WebRTC usually works best on the same Wi-Fi, but some networks still block or degrade peer connectivity.
- The app includes STUN, not TURN. Extremely restrictive networks can still fail.
- Large video or file transfers can hit iOS memory pressure.
- Camera and video capture through file inputs are best-effort and depend on the browser.
- iOS Safari install flow uses Share -> Add to Home Screen. It does not support the full Chromium `beforeinstallprompt` flow.

## Privacy model

- No accounts.
- No cloud storage.
- No upload database.
- No server-side file persistence.
- Theme preference is stored locally in `localStorage`.
- Received items stay in memory for the current session only unless the browser itself retains page state.

## Project structure

```text
index.html
manifest.webmanifest
sw.js
server.js
css/styles.css
js/main.js
js/app.js
js/core/storage.js
js/core/theme.js
js/core/pwa.js
js/state/store.js
js/bridge/session.js
js/bridge/signaling.js
js/bridge/transport.js
js/bridge/protocol.js
js/bridge/chunks.js
js/utils/files.js
js/utils/dom.js
assets/icons/*
README.md
```