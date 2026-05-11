import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const distDir = path.join(root, 'dist');
const assetsDir = path.join(root, 'assets');
const indexPath = path.join(distDir, 'index.html');
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const llmInjectPath = path.join(scriptsDir, 'lira-webllm-inject.html');

if (!fs.existsSync(indexPath)) {
  throw new Error('dist/index.html not found. Run `expo export --platform web` first.');
}

const copies = [
  ['apple-touch-icon.png', 'apple-touch-icon.png'],
  ['icon-192.png', 'icon-192.png'],
  ['icon-512.png', 'icon-512.png'],
  ['favicon.png', 'favicon.png'],
];

for (const [srcName, destName] of copies) {
  fs.copyFileSync(path.join(assetsDir, srcName), path.join(distDir, destName));
}

const manifest = {
  name: 'Lira',
  short_name: 'Lira',
  description: 'Lira — cycle tracking and care-box subscription',
  display: 'standalone',
  start_url: '/',
  scope: '/',
  background_color: '#FFFCF7',
  theme_color: '#FFFCF7',
  icons: [
    {
      src: '/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
    },
    {
      src: '/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
    },
  ],
};

fs.writeFileSync(
  path.join(distDir, 'manifest.webmanifest'),
  JSON.stringify(manifest, null, 2),
);

let html = fs.readFileSync(indexPath, 'utf8');

const headInsert = `
    <meta name="application-name" content="Lira" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="Lira" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="theme-color" content="#FFFCF7" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
    <script>
      // PWA self-heal: if the cached index.html references a JS bundle that no
      // longer exists on the server (after a redeploy), the page renders blank.
      // Detect an empty #root after the JS should have hydrated and reload with
      // a cache-bust to fetch the fresh index.html and bundle.
      (function(){
        var attempted = false;
        function bust(){
          if (attempted) return; attempted = true;
          try {
            if ('caches' in window) {
              caches.keys().then(function(keys){ keys.forEach(function(k){ caches.delete(k); }); });
            }
            if ('serviceWorker' in navigator) {
              navigator.serviceWorker.getRegistrations().then(function(rs){ rs.forEach(function(r){ r.unregister(); }); });
            }
          } catch(e){}
          var u = new URL(window.location.href);
          u.searchParams.set('_v', Date.now().toString());
          window.location.replace(u.toString());
        }
        window.addEventListener('error', function(ev){
          var t = ev && ev.target;
          if (t && t.tagName === 'SCRIPT' && t.src && t.src.indexOf('/_expo/') !== -1) {
            bust();
          }
        }, true);
        setTimeout(function(){
          var root = document.getElementById('root');
          if (!root || root.children.length === 0) bust();
        }, 4000);
      })();
    </script>
    <script>
      if ('serviceWorker' in navigator) {
        window.addEventListener('load', function(){
          navigator.serviceWorker.register('/sw.js').catch(function(){});
        });
      }
    </script>`;

if (!html.includes('apple-mobile-web-app-title')) {
  html = html.replace('<title>Lira</title>', `<title>Lira</title>${headInsert}`);
}

// Inject the chat backend redirector right before </body>. The bundled chat
// screen calls `${syncApiBaseUrl()}/v1/lira/{status,chat}`, which falls back
// to a hardcoded URL that is no longer reachable. The injected script
// monkey-patches window.fetch so those endpoints route to our Fly.io backend
// (backend/ in this repo). That keeps the chat zero-friction across all
// browsers (including iOS Safari) — no flags, no signup, no model download.
if (fs.existsSync(llmInjectPath) && !html.includes('LIRA_LLM_INJECTED')) {
  const llmInject = fs.readFileSync(llmInjectPath, 'utf8');
  if (html.includes('</body>')) {
    html = html.replace('</body>', `${llmInject}\n</body>`);
  } else {
    html = `${html}\n${llmInject}`;
  }
}

fs.writeFileSync(indexPath, html);

const swSource = `// Lira PWA service worker — network-first for navigation requests so the
// cached index.html never pins us to a stale JS bundle hash after redeploy.
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(event){
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var isNav = req.mode === 'navigate' || (req.headers.get('accept') || '').indexOf('text/html') !== -1;
  if (isNav || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(function(){ return new Response('', { status: 504 }); }));
  }
});
`;
fs.writeFileSync(path.join(distDir, 'sw.js'), swSource);

console.log('Post-processed dist for iOS home-screen metadata + PWA self-heal + on-device LLM injection.');
