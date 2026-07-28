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
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
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
          headers: { 'Content-Type': 'text/html;charset=utf-8' },
        });
      }

      if (path === '/api/objects' && request.method === 'GET') {
        const prefix = url.searchParams.get('prefix') || '';
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 1000);
        const cursor = url.searchParams.get('cursor') || undefined;
        const delimiter = url.searchParams.get('delimiter') || undefined;

        const listed = await env.BUCKET.list({ prefix, limit, cursor, delimiter });
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

      if (path === '/api/objects' && request.method === 'DELETE') {
        const body: { keys: string[] } = await request.json();
        if (!body.keys || !Array.isArray(body.keys) || body.keys.length === 0) {
          return errorResponse('Missing or empty keys array', 400);
        }
        await env.BUCKET.delete(body.keys);
        return jsonResponse({ deleted: body.keys.length });
      }

      const fileMatch = path.match(/^\/api\/objects\/(.+)$/);
      if (fileMatch && request.method === 'GET') {
        const key = decodeURIComponent(fileMatch[1]);
        const object = await env.BUCKET.get(key);

        if (!object) {
          return errorResponse('Not Found', 404);
        }

        const headers = new Headers(corsHeaders());
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('cache-control', 'public, max-age=86400');

        if (url.searchParams.has('download')) {
          const filename = key.split('/').pop() || 'file';
          headers.set('Content-Disposition', 'attachment; filename="' + filename + '"');
        }

        return new Response(object.body, { headers });
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
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>R2 Browser</title>
<style>
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --border: #30363d;
  --text: #c9d1d9;
  --text-dim: #8b949e;
  --accent: #58a6ff;
  --accent-hover: #79b8ff;
  --danger: #f85149;
  --danger-hover: #ff6b63;
  --success: #3fb950;
  --radius: 8px;
  --transition: 150ms ease;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  background:var(--bg);color:var(--text);
  min-height:100vh;line-height:1.5;
}
/* Header */
.header{
  position:sticky;top:0;z-index:100;
  background:var(--surface);border-bottom:1px solid var(--border);
  padding:16px 24px;display:flex;flex-wrap:wrap;align-items:center;gap:12px;
}
.header h1{font-size:20px;font-weight:600;color:var(--accent);margin-right:auto;white-space:nowrap;}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;width:100%;}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}
.filters input{padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;outline:none;}
.filters input:focus{border-color:var(--accent);}
.filters input[type="date"]{color-scheme:dark;width:150px;}
.filters input[type="text"]{width:180px;}
.filters select{padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;outline:none;cursor:pointer;}
.filters select:focus{border-color:var(--accent);}
/* Breadcrumb */
.breadcrumb{
  padding:6px 24px;display:flex;align-items:center;gap:4px;
  flex-wrap:wrap;border-bottom:1px solid var(--border);
  background:var(--bg);min-height:34px;font-size:13px;
}
.breadcrumb a{
  color:var(--accent);text-decoration:none;cursor:pointer;
  padding:2px 6px;border-radius:4px;
}
.breadcrumb a:hover{background:#1f2937;}
.breadcrumb .sep{color:var(--text-dim);}
.breadcrumb .current{color:var(--text-dim);font-weight:500;}
/* Grid folder item */
.grid-item.folder{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:6px;color:var(--text-dim);text-align:center;
}
.grid-item.folder .folder-icon{font-size:40px;}
.grid-item.folder .folder-name{
  font-size:12px;max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.grid-item.folder .folder-count{font-size:10px;color:var(--text-dim);opacity:0.7;}
.grid-item.folder:hover{color:var(--accent);border-color:var(--accent);}
.actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap;}
.actions .count{font-size:13px;color:var(--text-dim);white-space:nowrap;}
.btn{
  padding:6px 14px;border:1px solid var(--border);border-radius:6px;
  background:var(--surface);color:var(--text);font-size:13px;cursor:pointer;
  transition:background var(--transition),border-color var(--transition);
  white-space:nowrap;
}
.btn:hover{background:#21262d;border-color:#8b949e;}
.btn:disabled{opacity:0.4;cursor:not-allowed;}
.btn-danger{border-color:var(--danger);color:var(--danger);}
.btn-danger:hover:not(:disabled){background:var(--danger);color:#fff;}
.btn-accent{border-color:var(--accent);color:var(--accent);}
.btn-accent:hover:not(:disabled){background:var(--accent);color:#fff;}
/* Grid */
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(180px,1fr));
  gap:8px;padding:16px 24px;
}
.grid-item{
  position:relative;aspect-ratio:1;overflow:hidden;
  border-radius:6px;background:var(--surface);cursor:pointer;
  border:2px solid transparent;transition:border-color var(--transition);
}
.grid-item:hover{border-color:var(--accent);}
.grid-item.selected{border-color:var(--accent);}
.grid-item img{
  width:100%;height:100%;object-fit:cover;display:block;
}
.grid-item .file-icon{
  display:flex;align-items:center;justify-content:center;
  width:100%;height:100%;font-size:48px;color:var(--text-dim);
}
.grid-item .item-check{
  position:absolute;top:6px;left:6px;width:22px;height:22px;
  accent-color:var(--accent);cursor:pointer;z-index:2;
  opacity:0;transition:opacity var(--transition);
}
.grid-item:hover .item-check,
.grid-item.selected .item-check{opacity:1;}
.grid-item .item-info{
  position:absolute;bottom:0;left:0;right:0;
  background:linear-gradient(transparent,rgba(0,0,0,0.75));
  padding:24px 8px 6px;display:flex;flex-direction:column;gap:2px;
  opacity:0;transition:opacity var(--transition);
}
.grid-item:hover .item-info{opacity:1;}
.grid-item .item-info span{font-size:11px;color:#e6edf3;text-shadow:0 1px 3px rgba(0,0,0,0.8);}
/* Empty & Loading */
.empty-state,.loading-state{
  display:flex;align-items:center;justify-content:center;
  padding:80px 24px;color:var(--text-dim);font-size:14px;flex-direction:column;gap:12px;
}
.hidden{display:none!important;}
.spinner{
  width:36px;height:36px;border:3px solid var(--border);
  border-top-color:var(--accent);border-radius:50%;
  animation:spin 0.8s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
/* Lightbox */
.lightbox{
  position:fixed;inset:0;z-index:1000;
  background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;
}
.lightbox.hidden{display:none;}
.lightbox-content{
  position:relative;max-width:90vw;max-height:90vh;
  display:flex;flex-direction:column;align-items:center;
}
.lightbox-content img{max-width:90vw;max-height:80vh;object-fit:contain;border-radius:4px;}
.lightbox-close{
  position:absolute;top:-40px;right:0;background:none;border:none;
  color:#fff;font-size:32px;cursor:pointer;line-height:1;padding:4px;
}
.lightbox-nav{
  position:absolute;top:50%;transform:translateY(-50%);
  background:rgba(255,255,255,0.1);border:none;color:#fff;
  font-size:36px;cursor:pointer;padding:8px 16px;border-radius:4px;
  transition:background var(--transition);
}
.lightbox-nav:hover{background:rgba(255,255,255,0.25);}
.lightbox-prev{left:-60px;}
.lightbox-next{right:-60px;}
.lightbox-toolbar{
  display:flex;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap;justify-content:center;
}
.lightbox-toolbar span{font-size:13px;color:var(--text-dim);}
.lightbox-toolbar .btn{border-color:#484f58;}
/* Modal */
.modal-overlay{
  position:fixed;inset:0;z-index:2000;
  background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;
}
.modal-overlay.hidden{display:none;}
.modal{
  background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:24px;max-width:420px;width:90%;
}
.modal h2{font-size:18px;margin-bottom:8px;}
.modal p{font-size:14px;color:var(--text-dim);margin-bottom:20px;}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;}
/* Toast */
.toast{
  position:fixed;bottom:24px;right:24px;z-index:3000;
  padding:12px 20px;border-radius:8px;font-size:13px;
  animation:slideUp 0.3s ease;
  max-width:360px;
}
.toast-success{background:#1a3a1a;border:1px solid var(--success);color:#7ee787;}
.toast-error{background:#3a1a1a;border:1px solid var(--danger);color:#ffa198;}
@keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
/* Responsive */
@media(max-width:640px){
  .header{padding:12px 16px;}
  .grid{padding:8px 16px;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:4px;}
  .lightbox-nav{font-size:24px;padding:6px 10px;}
  .lightbox-prev{left:8px;}
  .lightbox-next{right:8px;}
  .filters{flex:1;min-width:100%;}
  .filters input{flex:1;}
}
</style>
</head>
<body>

<header class="header">
  <h1>R2 Browser</h1>
  <div class="toolbar">
    <div class="filters">
      <input type="text" id="prefixFilter" placeholder="Prefix filter...">
      <input type="date" id="dateFrom" title="From date">
      <input type="date" id="dateTo" title="To date">
      <select id="typeFilter">
        <option value="all">All Files</option>
        <option value="images" selected>Images Only</option>
      </select>
      <button class="btn" id="refreshBtn">Refresh</button>
    </div>
    <div class="actions">
      <span class="count" id="countLabel">0 items</span>
      <button class="btn" id="selectAllBtn">Select All</button>
      <button class="btn btn-accent" id="downloadBtn" disabled>Download</button>
      <button class="btn btn-danger" id="deleteBtn" disabled>Delete</button>
    </div>
  </div>
</header>

<div class="breadcrumb" id="breadcrumb"></div>

<main id="grid" class="grid"></main>

<div id="emptyState" class="empty-state hidden">
  <div style="font-size:48px;opacity:0.4">&#128247;</div>
  <span>No images found</span>
  <span style="font-size:12px">Upload images to your R2 bucket to get started</span>
</div>

<div id="loadingState" class="loading-state hidden">
  <div class="spinner"></div>
  <span>Loading...</span>
</div>

<div style="text-align:center;padding:16px 24px 40px;">
  <button class="btn" id="loadMoreBtn" style="display:none;">Load More</button>
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
      <button class="btn" id="lightboxDownload">Download</button>
      <button class="btn btn-danger" id="lightboxDelete">Delete</button>
    </div>
  </div>
</div>

<div id="deleteModal" class="modal-overlay hidden">
  <div class="modal">
    <h2>Delete Files</h2>
    <p>Are you sure you want to delete <strong id="deleteCount">0</strong> files? This action cannot be undone.</p>
    <div class="modal-actions">
      <button class="btn" id="deleteCancel">Cancel</button>
      <button class="btn btn-danger" id="deleteConfirm">Delete</button>
    </div>
  </div>
</div>

<script>
(function(){
  var IMG_EXTS = {jpg:1,jpeg:1,png:1,gif:1,webp:1,svg:1,bmp:1,ico:1,avif:1,tiff:1,tif:1,heic:1,heif:1};

  var state = {
    objects: [],
    folders: [],
    selected: {},
    cursor: null,
    hasMore: false,
    loading: false,
    lightboxIdx: -1
  };

  var grid = document.getElementById('grid');
  var emptyState = document.getElementById('emptyState');
  var loadingState = document.getElementById('loadingState');
  var loadMoreBtn = document.getElementById('loadMoreBtn');
  var countLabel = document.getElementById('countLabel');
  var downloadBtn = document.getElementById('downloadBtn');
  var deleteBtn = document.getElementById('deleteBtn');
  var selectAllBtn = document.getElementById('selectAllBtn');
  var refreshBtn = document.getElementById('refreshBtn');
  var prefixFilter = document.getElementById('prefixFilter');
  var dateFrom = document.getElementById('dateFrom');
  var dateTo = document.getElementById('dateTo');
  var typeFilter = document.getElementById('typeFilter');
  var lightbox = document.getElementById('lightbox');
  var lightboxImage = document.getElementById('lightboxImage');
  var lightboxFilename = document.getElementById('lightboxFilename');
  var lightboxMeta = document.getElementById('lightboxMeta');
  var deleteModal = document.getElementById('deleteModal');
  var deleteCount = document.getElementById('deleteCount');

  function getFilteredObjects() {
    var objs = state.objects;
    var from = dateFrom.value ? new Date(dateFrom.value + 'T00:00:00.000Z') : null;
    var to = dateTo.value ? new Date(dateTo.value + 'T23:59:59.999Z') : null;
    var type = typeFilter.value;

    return objs.filter(function(o) {
      if (type === 'images' && !IMG_EXTS[getExt(o.key)]) return false;
      if (from) {
        var d = new Date(o.uploaded);
        if (isNaN(d.getTime())) return false;
        if (d.getTime() < from.getTime()) return false;
      }
      if (to) {
        var d = new Date(o.uploaded);
        if (isNaN(d.getTime())) return false;
        if (d.getTime() > to.getTime()) return false;
      }
      return true;
    });
  }

  function getExt(name) {
    var parts = name.split('.');
    return (parts.pop() || '').toLowerCase();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function formatDate(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  }

  function selectCount() {
    return Object.keys(state.selected).length;
  }

  function updateToolbar() {
    var filtered = getFilteredObjects();
    var total = state.objects.length;
    var sel = selectCount();
    countLabel.textContent = filtered.length + ' / ' + total + ' items';
    downloadBtn.disabled = sel === 0;
    deleteBtn.disabled = sel === 0;
    loadMoreBtn.style.display = state.hasMore && !state.loading ? '' : 'none';
  }

  function navigateToFolder(prefix) {
    prefixFilter.value = prefix;
    state.cursor = null;
    state.selected = {};
    fetchObjects(false);
  }

  var breadcrumb = null;

  function renderBreadcrumb() {
    if (!breadcrumb) breadcrumb = document.getElementById('breadcrumb');
    var prefix = prefixFilter.value;
    breadcrumb.innerHTML = '';

    var allLink = document.createElement('a');
    allLink.textContent = 'All';
    allLink.addEventListener('click', function() { navigateToFolder(''); });
    breadcrumb.appendChild(allLink);

    if (prefix) {
      var parts = prefix.split('/').filter(function(p) { return p.length > 0; });
      var accumulated = '';
      for (var i = 0; i < parts.length; i++) {
        var sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = ' \u203A ';
        breadcrumb.appendChild(sep);

        accumulated += parts[i] + '/';
        var isLast = i === parts.length - 1;
        if (isLast) {
          var cur = document.createElement('span');
          cur.className = 'current';
          cur.textContent = parts[i];
          breadcrumb.appendChild(cur);
        } else {
          var lnk = document.createElement('a');
          lnk.textContent = parts[i];
          (function(acc) {
            lnk.addEventListener('click', function() { navigateToFolder(acc); });
          })(accumulated);
          breadcrumb.appendChild(lnk);
        }
      }
    }
  }

  function clearSelection() {
    state.selected = {};
    var checks = document.querySelectorAll('.item-check');
    for (var i = 0; i < checks.length; i++) checks[i].checked = false;
    updateSelectedStyles();
    updateToolbar();
  }

  function updateSelectedStyles() {
    var items = document.querySelectorAll('.grid-item');
    for (var i = 0; i < items.length; i++) {
      var key = items[i].dataset.key;
      if (state.selected[key]) {
        items[i].classList.add('selected');
      } else {
        items[i].classList.remove('selected');
      }
    }
  }

  function toggleSelect(key, checked) {
    if (checked) {
      state.selected[key] = true;
    } else {
      delete state.selected[key];
    }
    updateToolbar();
    updateSelectedStyles();
  }

  function selectAllVisible() {
    var filtered = getFilteredObjects();
    for (var i = 0; i < filtered.length; i++) {
      state.selected[filtered[i].key] = true;
    }
    renderGrid();
    updateToolbar();
  }

  function deselectAll() {
    clearSelection();
    renderGrid();
  }

  async function fetchObjects(append) {
    if (state.loading) return [];
    state.loading = true;
    if (!append) {
      grid.innerHTML = '';
      emptyState.classList.add('hidden');
    }
    loadingState.classList.remove('hidden');
    loadMoreBtn.style.display = 'none';

    var params = new URLSearchParams();
    params.set('limit', '200');
    params.set('delimiter', '/');
    if (prefixFilter.value) params.set('prefix', prefixFilter.value);
    if (append && state.cursor) params.set('cursor', state.cursor);

    try {
      var resp = await fetch('/api/objects?' + params.toString());
      if (!resp.ok) throw new Error('Failed to fetch: ' + resp.status);
      var data = await resp.json();
      if (append) {
        state.objects = state.objects.concat(data.objects);
      } else {
        state.objects = data.objects;
        state.folders = data.folders || [];
        state.selected = {};
      }
      state.cursor = data.cursor;
      state.hasMore = data.truncated;
      renderGrid();
      updateToolbar();
      renderBreadcrumb();
    } catch (err) {
      showToast('Failed to load files: ' + err.message, 'error');
      renderBreadcrumb();
    } finally {
      state.loading = false;
      loadingState.classList.add('hidden');
      updateToolbar();
    }
  }

  function renderGrid() {
    var filtered = getFilteredObjects();
    grid.innerHTML = '';

    if (filtered.length === 0 && state.folders.length === 0 && state.objects.length === 0 && !state.loading) {
      emptyState.classList.remove('hidden');
      return;
    }
    emptyState.classList.add('hidden');

    var fragment = document.createDocumentFragment();

    for (var f = 0; f < state.folders.length; f++) {
      var folder = state.folders[f];
      var folderItem = document.createElement('div');
      folderItem.className = 'grid-item folder';
      folderItem.dataset.prefix = folder.prefix;

      var icon = document.createElement('div');
      icon.className = 'folder-icon';
      icon.innerHTML = '&#128193;';
      folderItem.appendChild(icon);

      var fname = document.createElement('div');
      fname.className = 'folder-name';
      fname.textContent = folder.name;
      folderItem.appendChild(fname);

      folderItem.addEventListener('click', function(e) {
        navigateToFolder(this.dataset.prefix);
      });
      fragment.appendChild(folderItem);
    }

    for (var i = 0; i < filtered.length; i++) {
      var obj = filtered[i];
      var src = '/api/objects/' + encodeURIComponent(obj.key);
      var ext = getExt(obj.key);
      var isImg = IMG_EXTS[ext];

      var item = document.createElement('div');
      item.className = 'grid-item';
      if (state.selected[obj.key]) item.classList.add('selected');
      item.dataset.key = obj.key;
      item.dataset.index = i;

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'item-check';
      cb.checked = !!state.selected[obj.key];
      cb.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleSelect(this.parentElement.dataset.key, this.checked);
      });
      item.appendChild(cb);

      if (isImg) {
        var img = document.createElement('img');
        img.src = src;
        img.loading = 'lazy';
        img.alt = obj.key;
        img.addEventListener('error', function() {
          this.style.display = 'none';
          var fi = document.createElement('div');
          fi.className = 'file-icon';
          fi.innerHTML = '&#128196;';
          this.parentElement.appendChild(fi);
        });
        item.appendChild(img);
      } else {
        var fi = document.createElement('div');
        fi.className = 'file-icon';
        fi.innerHTML = '&#128196;';
        item.appendChild(fi);
      }

      var info = document.createElement('div');
      info.className = 'item-info';
      var nameSpan = document.createElement('span');
      nameSpan.textContent = obj.key.split('/').pop() || obj.key;
      info.appendChild(nameSpan);

      if (isImg) {
        var metaSpan = document.createElement('span');
        metaSpan.textContent = formatSize(obj.size) + ' | ' + formatDate(obj.uploaded);
        info.appendChild(metaSpan);
      } else {
        var metaSpan2 = document.createElement('span');
        metaSpan2.textContent = formatSize(obj.size);
        info.appendChild(metaSpan2);
      }
      item.appendChild(info);

      item.addEventListener('click', function(e) {
        if (e.target.tagName === 'INPUT') return;
        var idx = parseInt(this.dataset.index);
        openLightbox(idx);
      });

      fragment.appendChild(item);
    }
    grid.appendChild(fragment);

    if (filtered.length === 0 && state.objects.length > 0) {
      var el = document.createElement('div');
      el.className = 'empty-state';
      el.style.gridColumn = '1/-1';
      el.innerHTML = '<span>No files match the current filters</span>';
      grid.appendChild(el);
    }
  }

  function openLightbox(idx) {
    var filtered = getFilteredObjects();
    if (idx < 0 || idx >= filtered.length) return;
    state.lightboxIdx = idx;
    var obj = filtered[idx];
    lightbox.classList.remove('hidden');
    lightboxImage.src = '/api/objects/' + encodeURIComponent(obj.key);
    lightboxFilename.textContent = obj.key.split('/').pop() || obj.key;
    lightboxMeta.textContent = formatSize(obj.size) + ' | ' + formatDate(obj.uploaded);
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.add('hidden');
    lightboxImage.src = '';
    document.body.style.overflow = '';
  }

  function navigateLightbox(dir) {
    var filtered = getFilteredObjects();
    var newIdx = state.lightboxIdx + dir;
    if (newIdx < 0) newIdx = filtered.length - 1;
    if (newIdx >= filtered.length) newIdx = 0;
    openLightbox(newIdx);
  }

  function downloadSingle(key) {
    var a = document.createElement('a');
    a.href = '/api/objects/' + encodeURIComponent(key) + '?download=1';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  async function downloadSelected() {
    var keys = Object.keys(state.selected);
    if (keys.length === 0) return;
    if (keys.length === 1) {
      downloadSingle(keys[0]);
      return;
    }

    var toast = showToast('Preparing download...', 'success');

    try {
      var JSZip = window.JSZip;
      if (!JSZip) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
        JSZip = window.JSZip;
      }

      var zip = new JSZip();
      var promises = [];

      for (var i = 0; i < keys.length; i++) {
        (function(key) {
          var p = fetch('/api/objects/' + encodeURIComponent(key))
            .then(function(r) { return r.blob(); })
            .then(function(blob) {
              zip.file(key.split('/').pop() || key, blob);
            });
          promises.push(p);
        })(keys[i]);
      }

      await Promise.all(promises);
      var content = await zip.generateAsync({type:'blob'});
      var url = URL.createObjectURL(content);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'r2-download.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (toast) toast.remove();
      showToast('Downloaded ' + keys.length + ' files', 'success');
    } catch (err) {
      if (toast) toast.remove();
      showToast('Download failed: ' + err.message, 'error');
    }
  }

  function loadScript(src) {
    return new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function deleteConfirm() {
    var keys = Object.keys(state.selected);
    if (keys.length === 0) return;

    try {
      var resp = await fetch('/api/objects', {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({keys: keys})
      });
      if (!resp.ok) throw new Error('Delete failed: ' + resp.status);

      state.objects = state.objects.filter(function(o) {
        return !state.selected[o.key];
      });
      state.selected = {};
      deleteModal.classList.add('hidden');
      renderGrid();
      updateToolbar();
      showToast('Deleted ' + keys.length + ' files', 'success');
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  }

  function showDeleteModal() {
    var keys = Object.keys(state.selected);
    if (keys.length === 0) return;
    deleteCount.textContent = keys.length;
    deleteModal.classList.remove('hidden');
  }

  function showToast(msg, type) {
    var t = document.createElement('div');
    t.className = 'toast toast-' + type;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() {
      t.style.opacity = '0';
      t.style.transition = 'opacity 0.3s';
      setTimeout(function() { t.remove(); }, 300);
    }, 3000);
    return t;
  }

  // Event Listeners
  refreshBtn.addEventListener('click', function() {
    state.cursor = null;
    fetchObjects(false);
  });

  selectAllBtn.addEventListener('click', function() {
    if (selectCount() === getFilteredObjects().length && selectCount() > 0) {
      deselectAll();
    } else {
      selectAllVisible();
    }
  });

  downloadBtn.addEventListener('click', downloadSelected);
  deleteBtn.addEventListener('click', showDeleteModal);

  loadMoreBtn.addEventListener('click', function() {
    fetchObjects(true);
  });

  typeFilter.addEventListener('change', function() {
    renderGrid();
    updateToolbar();
  });

  dateFrom.addEventListener('input', function() {
    renderGrid();
    updateToolbar();
  });

  dateTo.addEventListener('input', function() {
    renderGrid();
    updateToolbar();
  });

  prefixFilter.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') navigateToFolder(prefixFilter.value);
  });

  // Lightbox events
  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightboxPrev').addEventListener('click', function() { navigateLightbox(-1); });
  document.getElementById('lightboxNext').addEventListener('click', function() { navigateLightbox(1); });

  lightbox.addEventListener('click', function(e) {
    if (e.target === lightbox) closeLightbox();
  });

  document.getElementById('lightboxDownload').addEventListener('click', function() {
    var filtered = getFilteredObjects();
    var obj = filtered[state.lightboxIdx];
    if (obj) downloadSingle(obj.key);
  });

  document.getElementById('lightboxDelete').addEventListener('click', function() {
    var filtered = getFilteredObjects();
    var obj = filtered[state.lightboxIdx];
    if (obj) {
      state.selected = {};
      state.selected[obj.key] = true;
      closeLightbox();
      showDeleteModal();
    }
  });

  // Delete modal events
  document.getElementById('deleteCancel').addEventListener('click', function() {
    deleteModal.classList.add('hidden');
  });
  document.getElementById('deleteConfirm').addEventListener('click', deleteConfirm);
  deleteModal.addEventListener('click', function(e) {
    if (e.target === deleteModal) deleteModal.classList.add('hidden');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    if (!lightbox.classList.contains('hidden')) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') navigateLightbox(-1);
      if (e.key === 'ArrowRight') navigateLightbox(1);
    }
    if (e.key === 'Escape' && !deleteModal.classList.contains('hidden')) {
      deleteModal.classList.add('hidden');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && document.activeElement === document.body) {
      e.preventDefault();
      selectAllVisible();
    }
  });

  // Init
  renderBreadcrumb();
  fetchObjects(false);
})();
</script>
</body>
</html>`;
