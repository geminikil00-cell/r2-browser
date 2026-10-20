const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tiff', 'tif', 'heic', 'heif'
]);

function isImage(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

export interface Env {
  BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (path === '/' && request.method === 'GET') {
        return new Response(HTML, {
          headers: {
            'Content-Type': 'text/html;charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }

      if (path === '/api/objects' && request.method === 'GET') {
        const prefix = url.searchParams.get('prefix') || '';
        const rawLimit = parseInt(url.searchParams.get('limit') || '', 10);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 200;
        const cursor = url.searchParams.get('cursor') || undefined;
        const delimiter = url.searchParams.get('delimiter') || undefined;
        const after = url.searchParams.get('after') || undefined;

        const listed = await env.BUCKET.list({ prefix, limit, cursor, delimiter, startAfter: after });
        const objects = listed.objects.map((obj) => ({
          key: obj.key,
          size: obj.size,
          uploaded: obj.uploaded.toISOString(),
          etag: obj.etag,
          isImage: isImage(obj.key),
        }));

        return jsonResponse({
          objects,
          folders: (listed.delimitedPrefixes || []).map((p) => ({
            prefix: p,
            name: p.replace(prefix, '').replace(/\/$/, ''),
          })),
          cursor: listed.truncated ? listed.cursor : null,
          truncated: listed.truncated,
        });
      }

      if (path === '/api/objects' && (request.method === 'DELETE' || request.method === 'POST')) {
        let body: { keys: string[] };
        try {
          body = await request.json();
        } catch {
          return errorResponse('Invalid JSON body', 400);
        }
        if (!body.keys || !Array.isArray(body.keys) || body.keys.length === 0) {
          return errorResponse('Missing or empty keys array', 400);
        }
        try {
          await env.BUCKET.delete(body.keys);
        } catch (batchErr: any) {
          console.error('Batch delete failed:', batchErr.message || batchErr);
          var failed: string[] = [];
          for (var i = 0; i < body.keys.length; i++) {
            try {
              await env.BUCKET.delete(body.keys[i]);
            } catch (singleErr: any) {
              console.error('Failed to delete key:', body.keys[i], singleErr.message || singleErr);
              failed.push(body.keys[i]);
            }
          }
          if (failed.length > 0) {
            return errorResponse('Failed to delete ' + failed.length + ' of ' + body.keys.length + ' files', 500);
          }
        }
        return jsonResponse({ deleted: body.keys.length });
      }

      const fileMatch = path.match(/^\/api\/objects\/(.+)$/);
      if (fileMatch && (request.method === 'GET' || request.method === 'HEAD')) {
        const key = decodeURIComponent(fileMatch[1]);
        const object = await env.BUCKET.get(key);

        if (!object) {
          return errorResponse('Not Found', 404);
        }

        const headers = new Headers(corsHeaders());
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('cache-control', 'public, max-age=604800');

        if (request.method === 'HEAD') {
          headers.set('content-length', String(object.size));
          return new Response(null, { headers });
        }

        if (url.searchParams.has('download')) {
          const filename = key.split('/').pop() || 'file';
          headers.set('Content-Disposition', 'attachment; filename="' + filename + '"');
        }

        return new Response(object.body, { headers });
      }

      if (path === '/manifest.json') {
        return new Response(MANIFEST, {
          headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        });
      }

      if (path === '/sw.js') {
        return new Response(SW, {
          headers: { ...corsHeaders(), 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
        });
      }

      if (path === '/icon.svg') {
        return new Response(ICON, {
          headers: { ...corsHeaders(), 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800' },
        });
      }

      return errorResponse('Not Found', 404);
    } catch (err: any) {
      console.error(err);
      return errorResponse(err.message || 'Internal Server Error', 500);
    }
  },
};

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<meta name="theme-color" content="#0d1117">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.json">
<title>R2 Browser</title>
<style>
:root{
  --bg:#0d1117;--surface:#161b22;--surface2:#1c2128;--border:#30363d;
  --text:#c9d1d9;--text-dim:#8b949e;--accent:#58a6ff;--danger:#f85149;--success:#3fb950;
  --shadow:rgba(0,0,0,.5);--radius:8px;--transition:120ms ease;
}
body.light{
  --bg:#ffffff;--surface:#f6f8fa;--surface2:#eaeef2;--border:#d0d7de;
  --text:#1f2328;--text-dim:#59636e;--accent:#0969da;--danger:#cf222e;--success:#1a7f37;
  --shadow:rgba(0,0,0,.15);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  background:var(--bg);color:var(--text);min-height:100vh;line-height:1.5;
}
.header{
  position:sticky;top:0;z-index:100;background:var(--surface);
  border-bottom:1px solid var(--border);padding:10px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;
}
.header h1{font-size:18px;font-weight:600;color:var(--accent);margin-right:auto;white-space:nowrap;}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px;}
.filters input,.filters select{
  padding:5px 8px;border:1px solid var(--border);border-radius:6px;
  background:var(--bg);color:var(--text);font-size:13px;outline:none;
}
.filters input:focus,.filters select:focus{border-color:var(--accent);}
.filters input[type="date"],.filters input[type="time"]{color-scheme:dark;width:126px;}
.filters input[type="text"],.filters input[type="search"]{width:160px;}
.filters input[type="search"]::-webkit-search-cancel-button{-webkit-appearance:none;}
.actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap;}
.actions .count{font-size:12px;color:var(--text-dim);white-space:nowrap;}
.btn{
  padding:5px 11px;border:1px solid var(--border);border-radius:6px;
  background:var(--surface);color:var(--text);font-size:13px;cursor:pointer;
  transition:background var(--transition),border-color var(--transition);white-space:nowrap;
}
.btn:hover{background:var(--surface2);border-color:var(--text-dim);}
.btn:disabled{opacity:.4;cursor:not-allowed;}
.btn.tiny{padding:2px 8px;font-size:11px;}
.btn-danger{border-color:var(--danger);color:var(--danger);}
.btn-danger:hover:not(:disabled){background:var(--danger);color:#fff;}
.btn-accent{border-color:var(--accent);color:var(--accent);}
.btn-accent:hover:not(:disabled){background:var(--accent);color:#fff;}
.btn.on{border-color:var(--accent);color:var(--accent);}
/* Breadcrumb */
.breadcrumb{
  padding:6px 16px;display:flex;align-items:center;gap:4px;flex-wrap:wrap;
  border-bottom:1px solid var(--border);background:var(--bg);min-height:32px;font-size:13px;
}
.breadcrumb a{color:var(--accent);text-decoration:none;cursor:pointer;padding:2px 6px;border-radius:4px;}
.breadcrumb a:hover{background:var(--surface2);}
.breadcrumb .sep,.breadcrumb .current{color:var(--text-dim);}
/* Scan bar */
.scanbar{
  display:flex;align-items:center;gap:8px;padding:4px 16px;font-size:12px;
  color:var(--text-dim);border-bottom:1px solid var(--border);background:var(--surface);
  position:sticky;top:0;z-index:90;
}
.scanbar.busy{color:var(--accent);}
.scanbar .dot{width:7px;height:7px;border-radius:50%;background:currentColor;animation:pulse 1s infinite;}
@keyframes pulse{50%{opacity:.25}}
/* Virtualized grid */
.grid{position:relative;padding:0;}
.grid-item{
  position:absolute;top:0;left:0;overflow:hidden;contain:strict;
  border-radius:6px;background:var(--surface);cursor:pointer;
  border:2px solid transparent;
}
.grid-item:hover{border-color:var(--accent);}
.grid-item.selected{border-color:var(--accent);}
.grid-item img{width:100%;height:100%;object-fit:cover;display:block;}
.grid-item .file-icon{
  display:flex;align-items:center;justify-content:center;
  width:100%;height:100%;font-size:40px;color:var(--text-dim);
}
.grid-item .item-check{
  position:absolute;top:5px;left:5px;width:20px;height:20px;
  accent-color:var(--accent);cursor:pointer;z-index:2;opacity:0;transition:opacity var(--transition);
}
.grid-item:hover .item-check,.grid-item.selected .item-check,body.selection-mode .grid-item .item-check{opacity:1;}
.grid-item .item-info{
  position:absolute;bottom:0;left:0;right:0;
  background:linear-gradient(transparent,rgba(0,0,0,.8));padding:20px 6px 5px;
  display:flex;flex-direction:column;gap:1px;opacity:0;transition:opacity var(--transition);
}
.grid-item:hover .item-info,body.selection-mode .grid-item .item-info{opacity:1;}
.grid-item .item-info span{
  font-size:11px;color:#e6edf3;text-shadow:0 1px 3px rgba(0,0,0,.9);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.grid-item .item-info span.meta{opacity:.75;font-size:10px;}
/* Folder tiles */
.grid-item.folder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:var(--text-dim);}
.grid-item.folder .folder-icon{font-size:32px;line-height:1;}
.grid-item.folder .folder-name{font-size:12px;max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.grid-item.folder .folder-count{font-size:10px;opacity:.7;}
.grid-item.folder:hover{color:var(--accent);border-color:var(--accent);}
/* Empty & Loading */
.empty-state{
  display:flex;align-items:center;justify-content:center;padding:70px 20px;
  color:var(--text-dim);font-size:14px;flex-direction:column;gap:10px;text-align:center;
}
.hidden{display:none!important;}
.spinner{width:30px;height:30px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
/* Lightbox */
.lightbox{position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.94);display:flex;align-items:center;justify-content:center;}
.lightbox-content{position:relative;max-width:94vw;max-height:92vh;display:flex;flex-direction:column;align-items:center;}
.lightbox-content img{max-width:94vw;max-height:78vh;object-fit:contain;border-radius:4px;}
.lightbox-close{
  position:absolute;top:-38px;right:0;background:none;border:none;
  color:#fff;font-size:30px;cursor:pointer;line-height:1;padding:4px;
}
.lightbox-nav{
  position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.12);
  border:none;color:#fff;font-size:32px;cursor:pointer;padding:8px 14px;border-radius:4px;
}
.lightbox-nav:hover{background:rgba(255,255,255,.28);}
.lightbox-prev{left:-56px;}
.lightbox-next{right:-56px;}
.lightbox-toolbar{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap;justify-content:center;}
.lightbox-toolbar span{font-size:12px;color:#8b949e;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lightbox-toolbar .btn{border-color:#484f58;background:#161b22;color:#c9d1d9;}
/* Modal */
.modal-overlay{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px;max-width:420px;width:90%;}
.modal h2{font-size:17px;margin-bottom:8px;}
.modal p{font-size:13px;color:var(--text-dim);margin-bottom:18px;}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;}
/* Toast */
.toast{
  position:fixed;bottom:20px;right:20px;z-index:3000;padding:10px 16px;border-radius:8px;
  font-size:13px;animation:slideUp .25s ease;max-width:340px;
}
.toast-success{background:#1a3a1a;border:1px solid var(--success);color:#7ee787;}
.toast-error{background:#3a1a1a;border:1px solid var(--danger);color:#ffa198;}
@keyframes slideUp{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
/* Selection bar */
.selection-bar{
  position:fixed;bottom:0;left:0;right:0;z-index:500;background:var(--surface);
  border-top:1px solid var(--border);padding:9px 14px;display:flex;align-items:center;gap:8px;
  transform:translateY(100%);transition:transform .2s ease;
}
.selection-bar.active{transform:translateY(0);}
.selection-bar .sel-count{font-size:13px;color:var(--text-dim);margin-right:auto;}
body.selection-mode{padding-bottom:56px;}
@media(max-width:768px){
  .header{padding:7px 10px;}
  .header h1{font-size:15px;}
  .filters input,.filters select{font-size:16px;padding:7px 8px;}
  .filters input[type="date"],.filters input[type="time"]{width:118px;}
  .filters input[type="text"],.filters input[type="search"]{width:132px;}
  .actions{width:100%;margin-left:0;justify-content:flex-end;}
  .btn{padding:7px 13px;font-size:13px;}
  .grid-item .item-check{opacity:1;width:24px;height:24px;top:3px;left:3px;}
  .grid-item .item-info{opacity:1;}
  .lightbox-nav{font-size:22px;padding:6px 9px;}
  .lightbox-prev{left:2px;}
  .lightbox-next{right:2px;}
  .breadcrumb{padding:5px 10px;font-size:12px;}
}
</style>
</head>
<body>

<header class="header">
  <h1>R2 Browser</h1>
  <div class="toolbar">
    <div class="filters">
      <input type="search" id="searchInput" placeholder="Search names (/)" autocomplete="off">
      <input type="text" id="prefixFilter" placeholder="Folder path..." autocomplete="off">
      <input type="date" id="dateFrom" title="From date">
      <input type="time" id="timeFrom" title="From time" step="60">
      <input type="date" id="dateTo" title="To date">
      <input type="time" id="timeTo" title="To time" step="60">
      <select id="typeFilter">
        <option value="images">Images</option>
        <option value="all">All files</option>
      </select>
      <select id="sortFilter" title="Sort order">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="name">Name A-Z</option>
        <option value="size">Largest first</option>
        <option value="smallest">Smallest first</option>
      </select>
      <select id="densityFilter" title="Thumbnail size">
        <option value="s">Small</option>
        <option value="m">Medium</option>
        <option value="l">Large</option>
      </select>
      <button class="btn" id="clearFiltersBtn">Clear</button>
    </div>
    <div class="actions">
      <span class="count" id="countLabel">0 items</span>
      <button class="btn" id="themeBtn" title="Toggle theme">Theme</button>
      <button class="btn" id="refreshBtn">Refresh</button>
      <button class="btn" id="selectAllBtn">Select All</button>
      <button class="btn btn-accent" id="downloadBtn" disabled>Download</button>
      <button class="btn btn-danger" id="deleteBtn" disabled>Delete</button>
    </div>
  </div>
</header>

<div class="breadcrumb" id="breadcrumb"></div>

<div class="scanbar" id="scanBar"><span id="scanText">Starting...</span></div>

<main id="grid" class="grid"></main>

<div id="emptyState" class="empty-state hidden">
  <div style="font-size:44px;opacity:.4">&#128247;</div>
  <span id="emptyMsg">No images found</span>
</div>

<div class="selection-bar" id="selectionBar">
  <span class="sel-count" id="selectionCount">0 selected</span>
  <button class="btn" id="selectionCancel">Cancel</button>
  <button class="btn btn-accent" id="selectionDownload">Download</button>
  <button class="btn btn-danger" id="selectionDelete">Delete</button>
</div>

<div id="lightbox" class="lightbox hidden">
  <div class="lightbox-content">
    <button class="lightbox-close" id="lightboxClose">&times;</button>
    <button class="lightbox-nav lightbox-prev" id="lightboxPrev">&lsaquo;</button>
    <img id="lightboxImage" src="" alt="">
    <button class="lightbox-nav lightbox-next" id="lightboxNext">&rsaquo;</button>
    <div class="lightbox-toolbar">
      <span id="lightboxFilename"></span>
      <span id="lightboxMeta"></span>
      <button class="btn" id="lightboxCopy">Copy link</button>
      <button class="btn" id="lightboxDownload">Download</button>
      <button class="btn btn-danger" id="lightboxDelete">Delete</button>
    </div>
  </div>
</div>

<div id="deleteModal" class="modal-overlay hidden">
  <div class="modal">
    <h2>Delete Files</h2>
    <p>Delete <strong id="deleteCount">0</strong> file(s) permanently?</p>
    <div class="modal-actions">
      <button class="btn" id="deleteCancel">Cancel</button>
      <button class="btn btn-danger" id="deleteConfirm">Delete</button>
    </div>
  </div>
</div>

<script>
(function(){
  'use strict';
  var IMG_EXTS = {jpg:1,jpeg:1,png:1,gif:1,webp:1,svg:1,bmp:1,ico:1,avif:1,tiff:1,tif:1,heic:1,heif:1};
  var PAGE = 1000;          // R2 max page size
  var PAD = 10;             // grid padding (px) - must match nothing in CSS, JS owns spacing
  var DEEP_MIN = 60;        // keep deep-scanning until at least this many items match
  var MAX_AUTO_PAGES = 25;  // auto-scan safety cap (25k objects)
  var OVERSCAN = 2;         // extra rows above/below viewport
  var SPARE_MAX = 200;      // recycled DOM nodes kept for instant scroll-back
  var LS = 'r2browser:v2';

  var state = {
    prefix:'', items:[], view:[], folders:0, matched:0,
    selected:{}, cursor:null, hasMore:false, loading:false, started:false, pages:0,
    sort:'newest', type:'images', q:'', density:'m',
    from:0, to:0, stopped:false,
    lightboxIdx:-1, lastIdx:-1, selectionMode:false, theme:'dark'
  };
  var seen = Object.create(null);
  var pool = Object.create(null);
  var spare = [];
  var rafPending = false;

  var $ = function(id){ return document.getElementById(id); };
  var grid = $('grid'), emptyState = $('emptyState'), emptyMsg = $('emptyMsg');
  var scanBar = $('scanBar'), scanText = $('scanText');
  var countLabel = $('countLabel'), downloadBtn = $('downloadBtn'), deleteBtn = $('deleteBtn');
  var selectAllBtn = $('selectAllBtn'), refreshBtn = $('refreshBtn'), themeBtn = $('themeBtn');
  var searchInput = $('searchInput'), prefixFilter = $('prefixFilter');
  var dateFrom = $('dateFrom'), dateTo = $('dateTo'), timeFrom = $('timeFrom'), timeTo = $('timeTo');
  var typeFilter = $('typeFilter'), sortFilter = $('sortFilter'), densityFilter = $('densityFilter');
  var clearFiltersBtn = $('clearFiltersBtn'), breadcrumb = $('breadcrumb');
  var lightbox = $('lightbox'), lightboxImage = $('lightboxImage');
  var lightboxFilename = $('lightboxFilename'), lightboxMeta = $('lightboxMeta');
  var deleteModal = $('deleteModal'), deleteCount = $('deleteCount');
  var selectionBar = $('selectionBar'), selectionCount = $('selectionCount');

  /* ---------- persistence ---------- */
  function save() {
    try {
      localStorage.setItem(LS, JSON.stringify({
        p:state.prefix, s:state.sort, t:state.type, q:state.q, d:state.density,
        f:state.from, v:state.to, th:state.theme
      }));
    } catch (e) {}
  }
  function restore() {
    var d = {};
    try { d = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) {}
    var hash = location.hash.replace(/^#/, '');
    state.prefix = (hash || d.p || '').replace(/\/$/, '');
    state.sort = d.s || 'newest';
    state.type = d.t || 'images';
    state.q = d.q || '';
    state.density = d.d || 'm';
    state.from = d.f || 0;
    state.to = d.v || 0;
    state.theme = d.th || 'dark';
    searchInput.value = state.q;
    prefixFilter.value = state.prefix;
    sortFilter.value = state.sort;
    typeFilter.value = state.type;
    densityFilter.value = state.density;
    applyTheme();
    if (state.from) { dateFrom.value = dayInput(state.from); timeFrom.value = hmInput(state.from); }
    if (state.to) { dateTo.value = dayInput(state.to); timeTo.value = hmInput(state.to); }
  }
  function dayInput(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate()); }
  function hmInput(ms) { var d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function applyTheme() {
    document.body.classList.toggle('light', state.theme === 'light');
    var m = document.querySelector('meta[name=theme-color]');
    if (m) m.setAttribute('content', state.theme === 'light' ? '#ffffff' : '#0d1117');
  }

  /* ---------- data fetch (progressive, cursor paged) ---------- */
  function fetchPage() {
    if (state.loading || (state.started && !state.hasMore)) return;
    state.loading = true;
    setScan(true, 'Fetching page ' + (state.pages + 1) + '...');
    var p = new URLSearchParams();
    p.set('limit', String(PAGE));
    if (state.prefix) p.set('prefix', state.prefix);
    if (state.started && state.cursor) p.set('cursor', state.cursor);
    fetch('/api/objects?' + p.toString(), { headers: { Accept: 'application/json' } })
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(d){
        ingest(d.objects || []);
        state.cursor = d.cursor || null;
        state.hasMore = !!d.truncated;
        state.started = true;
        state.pages++;
      })
      .catch(function(err){
        state.hasMore = false;
        showToast('Load failed: ' + err.message, 'error');
      })
      .then(function(){
        state.loading = false;
        applyView();
      });
  }
  function ingest(list) {
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (seen[o.key]) continue;
      seen[o.key] = 1;
      o.t = Date.parse(o.uploaded) || 0;
      state.items.push(o);
    }
  }
  function resetListing() {
    state.items = []; state.cursor = null; state.hasMore = false;
    state.started = false; state.pages = 0; state.selected = {};
    seen = Object.create(null);
    clearNodes();
  }

  /* ---------- derive view: folders + filtered+sorted files ---------- */
  function applyView() {
    var prefix = state.prefix;
    var groups = Object.create(null);
    var files = [];
    var q = state.q.toLowerCase();
    var imagesOnly = state.type === 'images';
    var from = state.from, to = state.to;
    var items = state.items;

    for (var i = 0; i < items.length; i++) {
      var o = items[i];
      var rest = o.key.slice(prefix.length);
      var slash = rest.indexOf('/');
      if (slash >= 0) {
        var name = rest.slice(0, slash);
        var g = groups[name];
        if (g) g.n++;
        else groups[name] = { name: name, prefix: prefix + name + '/', n: 1, folder: true };
        continue;
      }
      if (imagesOnly && !IMG_EXTS[ext(o.key)]) continue;
      if (from && o.t < from) continue;
      if (to && o.t > to) continue;
      if (q && o.key.toLowerCase().indexOf(q) < 0) continue;
      files.push(o);
    }

    var s = state.sort;
    if (s === 'newest') files.sort(function(a,b){ return b.t - a.t || (a.key < b.key ? -1 : 1); });
    else if (s === 'oldest') files.sort(function(a,b){ return a.t - b.t || (a.key < b.key ? -1 : 1); });
    else if (s === 'size') files.sort(function(a,b){ return b.size - a.size; });
    else if (s === 'smallest') files.sort(function(a,b){ return a.size - b.size; });
    else files.sort(function(a,b){ return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });

    var view = [];
    var names = Object.keys(groups).sort();
    for (var n = 0; n < names.length; n++) view.push(groups[names[n]]);
    state.folders = names.length;
    for (var f = 0; f < files.length; f++) view.push(files[f]);

    state.view = view;
    state.matched = files.length;
    renderStats();
    render();
    maybeAutoScan();
  }

  function renderStats() {
    var total = state.items.length;
    var hidden = total - state.matched - countFilesInFolders();
    var txt = state.matched + ' file' + (state.matched === 1 ? '' : 's');
    if (hidden > 0) txt += ' of ' + (state.matched + hidden);
    if (state.folders) txt += ' \u00b7 ' + state.folders + ' folder' + (state.folders === 1 ? '' : 's');
    countLabel.textContent = txt;
    emptyMsg.textContent = state.items.length
      ? 'No files match the current filters'
      : 'Nothing here \u2014 this folder is empty';
    emptyState.classList.toggle('hidden', state.view.length > 0);

    var scanning = state.loading;
    var more = state.hasMore && !state.stopped;
    scanBar.classList.toggle('busy', scanning);
    if (state.stopped && state.hasMore) setScan(false, 'Scan paused at ' + total + ' files', true);
    else if (more) setScan(scanning, 'Indexed ' + total + ' \u00b7 scanning for older files\u2026', true);
    else if (state.started) setScan(false, 'Indexed ' + total + ' files' + (state.folders ? ' in ' + state.folders + ' folders' : ''), false);
  }
  function countFilesInFolders() {
    var c = 0;
    for (var i = 0; i < state.view.length; i++) if (state.view[i].folder) c += state.view[i].n;
    return c;
  }
  function setScan(busy, text, withToggle) {
    scanBar.innerHTML = '';
    var dot = document.createElement('span');
    dot.className = 'dot';
    if (busy) scanBar.appendChild(dot);
    var span = document.createElement('span');
    span.id = 'scanText';
    span.textContent = text;
    scanBar.appendChild(span);
    if (withToggle && state.hasMore) {
      var b = document.createElement('button');
      b.className = 'btn tiny';
      b.id = 'scanToggle';
      b.textContent = state.stopped ? 'Resume' : 'Pause';
      b.addEventListener('click', function(){
        state.stopped = !state.stopped;
        if (!state.stopped) fetchPage();
        else renderStats();
      });
      scanBar.appendChild(b);
    }
  }
  function maybeAutoScan() {
    if (!state.hasMore || state.loading || state.stopped) return;
    if (state.view.length < DEEP_MIN && state.pages < MAX_AUTO_PAGES) fetchPage();
  }

  /* ---------- virtualized grid ---------- */
  function metrics() {
    var w = grid.clientWidth || window.innerWidth;
    var gap = state.density === 's' ? 4 : state.density === 'm' ? 8 : 12;
    var min = state.density === 's' ? 92 : state.density === 'm' ? 140 : 200;
    var inner = Math.max(min, w - PAD * 2);
    var cols = Math.max(1, Math.floor((inner + gap) / (min + gap)));
    var cell = Math.floor((inner - gap * (cols - 1)) / cols);
    return { cols: cols, cell: cell, gap: gap, rowH: cell + gap, rows: Math.ceil(state.view.length / cols) };
  }
  function render() {
    var m = metrics();
    var n = state.view.length;
    grid.style.height = (PAD * 2 + Math.max(0, m.rows * m.rowH - m.gap)) + 'px';

    var gridTop = grid.getBoundingClientRect().top + (window.pageYOffset || 0);
    var scroll = window.pageYOffset || 0;
    var vh = window.innerHeight;
    var from = scroll - gridTop - vh * 0.75;
    var to = scroll + vh * 1.25 - gridTop;
    var r0 = Math.max(0, Math.floor(from / m.rowH) - OVERSCAN);
    var r1 = Math.min(m.rows - 1, Math.ceil(to / m.rowH) + OVERSCAN);
    var i0 = r0 * m.cols;
    var i1 = Math.min(n, (r1 + 1) * m.cols);

    for (var i = i0; i < i1; i++) paint(i, m);

    for (var k in pool) {
      if (k === 'length') continue;
      var idx = +k;
      if (idx < i0 || idx >= i1) {
        var el = pool[k];
        delete pool[k];
        if (el.parentNode) el.parentNode.removeChild(el);
        if (spare.length < SPARE_MAX) spare.push(el);
      }
    }
    autoLoadNearBottom();
  }
  function paint(i, m) {
    var item = state.view[i];
    if (!item) return;
    var el = pool[i];
    if (!el) {
      el = spare.pop() || makeCell();
      pool[i] = el;
      grid.appendChild(el);
    }
    var col = i % m.cols, row = (i - col) / m.cols;
    var x = PAD + col * (m.cell + m.gap);
    var y = PAD + row * m.rowH;
    if (el._x !== x || el._y !== y || el._w !== m.cell) {
      el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      el.style.width = m.cell + 'px';
      el.style.height = m.cell + 'px';
      el._x = x; el._y = y; el._w = m.cell;
    }
    if (el._k !== item.key) {
      el._k = item.key;
      el.dataset.key = item.key;
      el.dataset.i = i;
    }
    el._c.className = 'grid-item' + (item.folder ? ' folder' : '') + (state.selected[item.key] ? ' selected' : '');
    el._cb.style.display = item.folder ? 'none' : '';
    el._cb.checked = !item.folder && !!state.selected[item.key];
    el._img.style.display = (!item.folder && item.isImage) ? '' : 'none';
    el._fi.style.display = item.folder ? 'none' : '';
    el._fc.style.display = item.folder ? '' : 'none';
    el._fin.style.display = item.folder ? 'none' : '';
    if (item.folder) {
      el._fc.textContent = '\uD83D\uDCC2';
      el._fn.textContent = item.name;
      el._fk.textContent = item.n + ' file' + (item.n === 1 ? '' : 's');
      el._img.removeAttribute('src');
    } else {
      el._fn.textContent = baseName(item.key);
      el._fm.textContent = formatSize(item.size) + ' \u00b7 ' + formatDate(item.t);
      if (item.isImage) {
        var src = '/api/objects/' + encodeURIComponent(item.key);
        if (el._img.getAttribute('src') !== src) el._img.src = src;
      } else el._img.removeAttribute('src');
    }
  }
  function makeCell() {
    var el = document.createElement('div');
    var cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'item-check';
    var img = document.createElement('img');
    img.className = 'thumb'; img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
    var fi = document.createElement('div');
    fi.className = 'file-icon';
    fi.innerHTML = '&#128196;';
    var fc = document.createElement('div');
    fc.className = 'folder-icon';
    var fin = document.createElement('div');
    fin.className = 'item-info';
    var fn = document.createElement('span');
    fn.className = 'name';
    var fk = document.createElement('span');
    fk.className = 'meta folder-count';
    var fm = document.createElement('span');
    fm.className = 'meta';
    fin.appendChild(fn); fin.appendChild(fm);
    el.appendChild(cb); el.appendChild(img); el.appendChild(fi); el.appendChild(fc); el.appendChild(fin);
    el._cb = cb; el._img = img; el._fi = fi; el._fc = fc; el._fn = fn; el._fm = fm; el._fk = fk;
    el._c = el; el._k = null; el._x = null; el._y = null; el._w = null;
    img.addEventListener('error', function(){ this.style.display = 'none'; });
    el.addEventListener('click', onCellClick);
    var timer = null;
    el.addEventListener('touchstart', function(){
      timer = setTimeout(function(){
        var it = state.view[+el.dataset.i];
        if (!it || it.folder) return;
        enterSelectionMode();
        toggleSelect(it.key, true);
        if (navigator.vibrate) navigator.vibrate(20);
      }, 480);
    }, { passive: true });
    el.addEventListener('touchend', function(){ clearTimeout(timer); });
    el.addEventListener('touchmove', function(){ clearTimeout(timer); });
    return el;
  }
  function clearNodes() {
    for (var k in pool) {
      var el = pool[k];
      if (el.parentNode) el.parentNode.removeChild(el);
      delete pool[k];
    }
    spare.length = 0;
  }
  function onCellClick(e) {
    var i = +this.dataset.i;
    var item = state.view[i];
    if (!item) return;
    if (e.target === this._cb) {
      toggleSelect(item.key, this._cb.checked);
      state.lastIdx = i;
      return;
    }
    if (item.folder) { navigateToFolder(item.prefix); return; }
    if (state.selectionMode) {
      toggleSelect(item.key, !state.selected[item.key]);
      return;
    }
    if (e.shiftKey && state.lastIdx >= 0) { rangeSelect(state.lastIdx, i); return; }
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(item.key, !state.selected[item.key]);
      state.lastIdx = i;
      return;
    }
    state.lastIdx = i;
    openLightbox(i);
  }

  /* ---------- selection ---------- */
  function selCount() {
    var n = 0;
    for (var k in state.selected) if (state.selected[k]) n++;
    return n;
  }
  function toggleSelect(key, checked) {
    if (checked) state.selected[key] = 1;
    else delete state.selected[key];
    updateToolbar();
    for (var i = 0; i < state.view.length; i++) {
      var el = pool[i];
      if (el && el.dataset.key === key) {
        el._cb.checked = checked;
        el._c.classList.toggle('selected', !!checked);
      }
    }
    if (state.selectionMode) selectionCount.textContent = selCount() + ' selected';
  }
  function rangeSelect(a, b) {
    var lo = Math.min(a, b), hi = Math.max(a, b);
    for (var i = lo; i <= hi && i < state.view.length; i++) {
      var it = state.view[i];
      if (!it.folder) state.selected[it.key] = 1;
    }
    updateToolbar();
    render();
  }
  function clearSelection() {
    state.selected = {};
    for (var i in pool) { pool[i]._cb.checked = false; pool[i]._c.classList.remove('selected'); }
    updateToolbar();
  }
  function enterSelectionMode() {
    if (state.selectionMode) return;
    state.selectionMode = true;
    document.body.classList.add('selection-mode');
    selectionBar.classList.add('active');
    selectionCount.textContent = selCount() + ' selected';
  }
  function exitSelectionMode() {
    state.selectionMode = false;
    document.body.classList.remove('selection-mode');
    selectionBar.classList.remove('active');
    clearSelection();
  }
  function updateToolbar() {
    var n = selCount();
    downloadBtn.disabled = n === 0;
    deleteBtn.disabled = n === 0;
    selectionCount.textContent = n + ' selected';
  }

  /* ---------- navigation ---------- */
  function navigateToFolder(p) {
    p = (p || '').replace(/\/$/, '');
    if (p === state.prefix) return;
    state.prefix = p;
    prefixFilter.value = p;
    location.hash = p ? '#' + p : '';
    save();
    resetListing();
    renderBreadcrumb();
    renderStats();
    fetchPage();
  }
  function renderBreadcrumb() {
    breadcrumb.innerHTML = '';
    var all = document.createElement('a');
    all.textContent = 'Home';
    all.addEventListener('click', function(){ navigateToFolder(''); });
    breadcrumb.appendChild(all);
    if (state.prefix) {
      var parts = state.prefix.split('/').filter(function(p){ return p; });
      var acc = '';
      for (var i = 0; i < parts.length; i++) {
        var sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = ' \u203A ';
        breadcrumb.appendChild(sep);
        acc += parts[i] + '/';
        if (i === parts.length - 1) {
          var cur = document.createElement('span');
          cur.className = 'current';
          cur.textContent = parts[i];
          breadcrumb.appendChild(cur);
        } else {
          var target = acc;
          var lnk = document.createElement('a');
          lnk.textContent = parts[i];
          lnk.addEventListener('click', function(){ navigateToFolder(target); });
          breadcrumb.appendChild(lnk);
        }
      }
    }
  }

  /* ---------- lightbox ---------- */
  function openLightbox(i) {
    var item = state.view[i];
    if (!item || item.folder) return;
    state.lightboxIdx = i;
    lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    var url = '/api/objects/' + encodeURIComponent(item.key);
    if (lightboxImage.getAttribute('src') !== url) lightboxImage.src = url;
    lightboxFilename.textContent = item.key;
    lightboxMeta.textContent = formatSize(item.size) + ' \u00b7 ' + formatDate(item.t) + ' \u00b7 ' + (i + 1) + '/' + state.view.length;
    preload(i + 1); preload(i - 1);
  }
  function preload(i) {
    var it = state.view[i];
    if (!it || it.folder || !it.isImage) return;
    var img = new Image();
    img.src = '/api/objects/' + encodeURIComponent(it.key);
  }
  function stepLightbox(d) {
    var n = state.view.length;
    if (n < 2) return;
    var i = state.lightboxIdx + d;
    if (i < 0) i = n - 1;
    if (i >= n) i = 0;
    openLightbox(i);
  }
  function closeLightbox() {
    lightbox.classList.add('hidden');
    lightboxImage.removeAttribute('src');
    document.body.style.overflow = '';
  }
  function currentKey() {
    var it = state.view[state.lightboxIdx];
    return it && !it.folder ? it.key : null;
  }

  /* ---------- download / delete ---------- */
  function objUrl(key) { return '/api/objects/' + encodeURIComponent(key); }
  function downloadSingle(key) {
    var a = document.createElement('a');
    a.href = objUrl(key) + '?download=1';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  function loadScript(src) {
    return new Promise(function(res, rej) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  async function downloadSelected() {
    var keys = Object.keys(state.selected);
    if (!keys.length) return;
    if (keys.length === 1) { downloadSingle(keys[0]); return; }
    var toast = showToast('Zipping ' + keys.length + ' files...', 'success');
    try {
      var JSZip = window.JSZip;
      if (!JSZip) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
        JSZip = window.JSZip;
      }
      var zip = new JSZip();
      await Promise.all(keys.map(function(key){
        return fetch(objUrl(key)).then(function(r){ return r.blob(); }).then(function(b){ zip.file(baseName(key), b); });
      }));
      var blob = await zip.generateAsync({ type: 'blob' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'r2-download.zip';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(url); }, 5000);
      toast.remove();
      showToast('Downloaded ' + keys.length + ' files', 'success');
    } catch (err) {
      toast.remove();
      showToast('Download failed: ' + err.message, 'error');
    }
  }
  function showDeleteModal() {
    var n = selCount();
    if (!n) return;
    deleteCount.textContent = n;
    deleteModal.classList.remove('hidden');
  }
  async function doDelete() {
    var keys = Object.keys(state.selected);
    if (!keys.length) return;
    deleteModal.classList.add('hidden');
    try {
      var resp = await fetch('/api/objects', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: keys })
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var removed = Object.create(null);
      for (var i = 0; i < keys.length; i++) removed[keys[i]] = 1;
      state.items = state.items.filter(function(o){ return !removed[o.key]; });
      exitSelectionMode();
      applyView();
      showToast('Deleted ' + keys.length + ' file' + (keys.length === 1 ? '' : 's'), 'success');
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  }
  function showToast(msg, type) {
    var t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function(){ t.remove(); }, 3000);
    return t;
  }

  /* ---------- helpers ---------- */
  function ext(name) { var p = name.split('.'); return (p.pop() || '').toLowerCase(); }
  function baseName(key) { var p = key.split('/'); return p[p.length - 1] || key; }
  function formatSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function formatDate(ms) {
    var d = new Date(ms);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function parseBound(dateVal, timeVal, endOfDay) {
    if (!dateVal) return 0;
    var t = (timeVal || '').split(':');
    var parts = dateVal.split('-');
    return new Date(+parts[0], +parts[1] - 1, +parts[2], +(t[0] || 0), +(t[1] || 0), endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime() || 0;
  }

  /* ---------- events ---------- */
  var searchTimer = null;
  searchInput.addEventListener('input', function(){
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){
      state.q = searchInput.value.trim();
      save();
      applyView();
    }, 110);
  });
  searchInput.addEventListener('keydown', function(e){ if (e.key === 'Escape') { searchInput.value = ''; state.q = ''; applyView(); searchInput.blur(); } });

  function bindBound(dateEl, timeEl, isTo) {
    var h = function(){
      state[isTo ? 'to' : 'from'] = dateEl.value ? parseBound(dateEl.value, timeEl.value, isTo) : 0;
      save();
      applyView();
    };
    dateEl.addEventListener('change', h);
    timeEl.addEventListener('change', h);
  }
  bindBound(dateFrom, timeFrom, false);
  bindBound(dateTo, timeTo, true);

  typeFilter.addEventListener('change', function(){ state.type = typeFilter.value; save(); applyView(); });
  sortFilter.addEventListener('change', function(){ state.sort = sortFilter.value; save(); applyView(); });
  densityFilter.addEventListener('change', function(){
    state.density = densityFilter.value; save();
    clearNodes(); render();
  });
  clearFiltersBtn.addEventListener('click', function(){
    searchInput.value = ''; dateFrom.value = ''; timeFrom.value = ''; dateTo.value = ''; timeTo.value = '';
    state.q = ''; state.from = 0; state.to = 0;
    save(); applyView();
  });
  themeBtn.addEventListener('click', function(){
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    applyTheme(); save();
  });
  refreshBtn.addEventListener('click', function(){
    resetListing();
    renderStats();
    fetchPage();
  });
  prefixFilter.addEventListener('keydown', function(e){
    if (e.key === 'Enter') navigateToFolder(prefixFilter.value);
  });
  selectAllBtn.addEventListener('click', function(){
    var all = true;
    for (var i = 0; i < state.view.length; i++) {
      var it = state.view[i];
      if (!it.folder && !state.selected[it.key]) { all = false; break; }
    }
    if (all) { clearSelection(); return; }
    for (var j = 0; j < state.view.length; j++) {
      var o = state.view[j];
      if (!o.folder) state.selected[o.key] = 1;
    }
    updateToolbar();
    render();
  });
  downloadBtn.addEventListener('click', downloadSelected);
  deleteBtn.addEventListener('click', showDeleteModal);
  $('deleteCancel').addEventListener('click', function(){ deleteModal.classList.add('hidden'); });
  $('deleteConfirm').addEventListener('click', doDelete);
  deleteModal.addEventListener('click', function(e){ if (e.target === deleteModal) deleteModal.classList.add('hidden'); });
  $('selectionCancel').addEventListener('click', exitSelectionMode);
  $('selectionDownload').addEventListener('click', function(){ downloadSelected(); exitSelectionMode(); });
  $('selectionDelete').addEventListener('click', showDeleteModal);

  $('lightboxClose').addEventListener('click', closeLightbox);
  $('lightboxPrev').addEventListener('click', function(){ stepLightbox(-1); });
  $('lightboxNext').addEventListener('click', function(){ stepLightbox(1); });
  $('lightboxDownload').addEventListener('click', function(){ var k = currentKey(); if (k) downloadSingle(k); });
  $('lightboxCopy').addEventListener('click', function(){
    var k = currentKey();
    if (!k) return;
    var url = location.origin + objUrl(k);
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function(){ showToast('Link copied', 'success'); });
    else showToast(url, 'success');
  });
  $('lightboxDelete').addEventListener('click', function(){
    var k = currentKey();
    if (!k) return;
    state.selected = {};
    state.selected[k] = 1;
    updateToolbar();
    closeLightbox();
    showDeleteModal();
  });
  lightbox.addEventListener('click', function(e){ if (e.target === lightbox) closeLightbox(); });
  var tsx = 0, tsy = 0;
  lightbox.addEventListener('touchstart', function(e){
    if (e.touches.length === 1) { tsx = e.touches[0].clientX; tsy = e.touches[0].clientY; }
  }, { passive: true });
  lightbox.addEventListener('touchend', function(e){
    var dx = e.changedTouches[0].clientX - tsx;
    var dy = e.changedTouches[0].clientY - tsy;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) stepLightbox(dx < 0 ? 1 : -1);
  });

  function autoLoadNearBottom() {
    if (!state.hasMore || state.loading || state.stopped) return;
    var doc = document.documentElement;
    if (window.pageYOffset + window.innerHeight + 800 >= doc.scrollHeight) fetchPage();
  }
  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function(){ rafPending = false; render(); });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', function(){ render(); });

  document.addEventListener('keydown', function(e){
    var typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); searchInput.focus(); return; }
    if (e.key === 'Escape') {
      if (typing) { document.activeElement.blur(); return; }
      if (!lightbox.classList.contains('hidden')) { closeLightbox(); return; }
      if (!deleteModal.classList.contains('hidden')) { deleteModal.classList.add('hidden'); return; }
      if (state.selectionMode) exitSelectionMode();
      return;
    }
    if (typing) return;
    if (!lightbox.classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); stepLightbox(1); }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      for (var i = 0; i < state.view.length; i++) if (!state.view[i].folder) state.selected[state.view[i].key] = 1;
      updateToolbar();
      render();
    }
  });

  /* ---------- init ---------- */
  restore();
  renderBreadcrumb();
  updateToolbar();
  fetchPage();
})();
</script>
<script>
if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js');}
</script>
</body>
</html>`;

const MANIFEST = JSON.stringify({
  name: 'R2 Browser',
  short_name: 'R2Browser',
  description: 'Cloudflare R2 storage image browser',
  start_url: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#0d1117',
  theme_color: '#0d1117',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
  ],
});

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  <rect width="512" height="512" rx="96" fill="#0d1117"/>
  <path d="M160 200c0-26.51 21.49-48 48-48h16c8.84 0 16-7.16 16-16v-8c0-17.67 14.33-32 32-32h32c8.84 0 16 7.16 16 16s-7.16 16-16 16h-24c-4.42 0-8 3.58-8 8v8c0 26.51-21.49 48-48 48h-16c-8.84 0-16 7.16-16 16v16c0 8.84 7.16 16 16 16h96c26.51 0 48 21.49 48 48v48c0 8.84 7.16 16 16 16h16c8.84 0 16 7.16 16 16v8c0 17.67-14.33 32-32 32h-32c-8.84 0-16-7.16-16-16s7.16-16 16-16h24c4.42 0 8-3.58 8-8v-8c0-8.84-7.16-16-16-16h-16c-26.51 0-48-21.49-48-48v-48c0-8.84-7.16-16-16-16h-96c-26.51 0-48-21.49-48-48v-16z" fill="#58a6ff"/>
  <rect x="128" y="264" width="96" height="64" rx="12" fill="#58a6ff" opacity="0.6"/>
  <rect x="240" y="264" width="96" height="64" rx="12" fill="#58a6ff" opacity="0.4"/>
</svg>`;

const SW = `
const CACHE = 'r2browser-v2';
const ASSETS = ['/', '/manifest.json', '/icon.svg'];

self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(ASSETS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // API: network first, cache fallback so the app still opens offline / on flaky networks.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).then(function(resp) {
        var clone = resp.clone();
        caches.open(CACHE).then(function(c) { c.put(req, clone); });
        return resp;
      }).catch(function() {
        return caches.match(req).then(function(hit) {
          return hit || new Response(JSON.stringify({ error: 'offline', objects: [], folders: [], cursor: null, truncated: false }), { headers: { 'Content-Type': 'application/json' } });
        });
      })
    );
    return;
  }

  // Shell/assets: stale-while-revalidate, updates land on next reload.
  e.respondWith(
    caches.match(req).then(function(cached) {
      var net = fetch(req).then(function(resp) {
        if (resp.ok) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c) { c.put(req, clone); });
        }
        return resp;
      }).catch(function() { return cached; });
      return cached || net;
    })
  );
});
`;