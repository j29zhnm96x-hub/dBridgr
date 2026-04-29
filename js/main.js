function renderBootstrapFailure(error) {
  const message = error instanceof Error ? error.message : 'Unknown startup error';
  const shell = document.querySelector('.app-shell');
  const fallback = document.createElement('section');
  fallback.style.maxWidth = '42rem';
  fallback.style.margin = '4rem auto';
  fallback.style.padding = '1.5rem';
  fallback.style.borderRadius = '1.5rem';
  fallback.style.background = 'rgba(20, 24, 33, 0.92)';
  fallback.style.color = '#f5f3ee';
  fallback.style.boxShadow = '0 24px 60px rgba(0, 0, 0, 0.28)';
  fallback.innerHTML = [
    '<p style="margin:0 0 0.5rem;opacity:0.7;text-transform:uppercase;letter-spacing:0.14em;font-size:0.8rem;">Startup Error</p>',
    '<h1 style="margin:0 0 0.9rem;font-size:1.8rem;line-height:1.1;">dBridgr could not finish loading.</h1>',
    '<p style="margin:0 0 0.9rem;line-height:1.55;">If this is deployed on Cloudflare Pages, make sure the project is publishing the actual app files and not an empty nested folder. If you are using static Pages hosting, remember that pairing still needs a signaling backend for <code>/api/*</code>.</p>',
    `<pre style="margin:0;padding:1rem;border-radius:1rem;background:rgba(255,255,255,0.08);overflow:auto;white-space:pre-wrap;word-break:break-word;">${message}</pre>`,
  ].join('');

  if (shell) {
    shell.replaceChildren(fallback);
  } else {
    document.body.append(fallback);
  }
}

async function main() {
  try {
    const assetVersion = '2026-04-29-6';
    const [{ bootstrapApp }, { initTheme }] = await Promise.all([
      import(`./app.js?v=${assetVersion}`),
      import(`./core/theme.js?v=${assetVersion}`),
    ]);

    bootstrapApp({
      initialTheme: initTheme(),
    });
  } catch (error) {
    console.error('dBridgr bootstrap failed', error);
    renderBootstrapFailure(error);
  }
}

void main();