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
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
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

interface SerializedObj {
  key: string;
  size: number;
  uploaded: string;
  ts: number;
  etag: string;
  isImage: boolean;
}

function extractPrefixTs(key: string, prefix: string): number {
  const rest = key.slice(prefix.length);
  const m = rest.match(/^(\d{10})/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n >= 1000000000 && n <= 2500000000 ? n : 0;
}

function extractAnyTs(key: string): number {
  const base = key.split('/').pop() || key;
  const m = base.match(/^(\d{10})/);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n >= 1000000000 && n <= 2500000000 ? n : 0;
}

function serializeObj(obj: R2Object): SerializedObj {
  const uploadedMs = obj.uploaded.getTime();
  const keyTs = extractAnyTs(obj.key);
  return {
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
    ts: keyTs ? keyTs * 1000 : uploadedMs,
    etag: obj.etag,
    isImage: isImage(obj.key),
  };
}

function matchesFilters(
  obj: SerializedObj,
  fromMs: number,
  toMs: number,
  q: string,
  cat: string,
  imagesOnly: boolean
): boolean {
  if (imagesOnly && !obj.isImage) return false;
  const t = new Date(obj.uploaded).getTime();
  if (fromMs > 0 && t < fromMs && obj.ts < fromMs) return false;
  if (toMs > 0 && t > toMs && obj.ts > toMs) return false;
  if (cat && !obj.key.toLowerCase().includes(cat)) return false;
  if (q && !obj.key.toLowerCase().includes(q)) return false;
  return true;
}

async function listPrefixNewest(
  bucket: R2Bucket,
  prefix: string,
  opts: {
    limit: number;
    fromMs: number;
    toMs: number;
    beforeKey: string;
    beforeTs: number;
    q: string;
    cat: string;
    imagesOnly: boolean;
  }
): Promise<{
  objects: SerializedObj[];
  folders: { prefix: string; name: string }[];
  hasMore: boolean;
}> {
  const { limit, fromMs, toMs, beforeKey, beforeTs, q, cat, imagesOnly } = opts;
  const head = await bucket.list({ prefix, delimiter: '/', limit: 250 });
  const folders = (head.delimitedPrefixes || [])
    .filter((p) => p !== 'thumb/')
    .map((p) => ({
      prefix: p,
      name: p.replace(prefix, '').replace(/\/$/, ''),
    }));

  if (!head.truncated) {
    const all = head.objects
      .map(serializeObj)
      .filter((o) => {
        if (beforeKey && o.key >= beforeKey) return false;
        if (beforeTs > 0 && extractPrefixTs(o.key, prefix) * 1000 >= beforeTs) return false;
        return matchesFilters(o, fromMs, toMs, q, cat, imagesOnly);
      });
    all.sort((a, b) => b.key.localeCompare(a.key));
    return {
      objects: all.slice(0, limit),
      folders,
      hasMore: all.length > limit,
    };
  }

  const firstObj = head.objects[0];
  const firstTs = firstObj ? extractPrefixTs(firstObj.key, prefix) : 0;

  if (!firstTs) {
    const all = head.objects
      .map(serializeObj)
      .filter((o) => (!beforeKey || o.key < beforeKey) && matchesFilters(o, fromMs, toMs, q, cat, imagesOnly));
    all.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
    return {
      objects: all.slice(0, limit),
      folders,
      hasMore: true,
    };
  }

  const minTs = fromMs > 0 ? Math.max(firstTs, Math.floor(fromMs / 1000) - 600) : firstTs;
  let maxTs = toMs > 0 ? Math.floor(toMs / 1000) + 600 : Math.floor(Date.now() / 1000) + 86400;
  if (beforeKey) {
    const bTs = extractPrefixTs(beforeKey, prefix);
    if (bTs > 0) maxTs = Math.min(maxTs, bTs + 1);
  }
  if (beforeTs > 0) {
    maxTs = Math.min(maxTs, Math.floor(beforeTs / 1000) + 1);
  }

  if (maxTs < minTs) {
    return { objects: [], folders, hasMore: false };
  }

  const isValidUpper = (o: R2Object): boolean => {
    if (beforeKey && o.key >= beforeKey) return false;
    const t = extractPrefixTs(o.key, prefix);
    if (beforeTs > 0 && t * 1000 >= beforeTs && beforeKey && o.key >= beforeKey) return false;
    return t <= maxTs;
  };

  // Probe recent window first (last 12 hours before maxTs)
  const quickWindow = q || cat ? 172800 : 43200;
  const quickStart = Math.max(minTs - 1, maxTs - quickWindow);
  const quick = await bucket.list({ prefix, startAfter: prefix + String(quickStart), limit: 1000 });
  const quickValid = quick.objects.filter(isValidUpper);

  if (quickValid.length === 0) {
    if (quickStart <= minTs - 1) {
      return { objects: [], folders, hasMore: false };
    }
    // Binary search [minTs - 1, quickStart] to find the newest existing timestamp
    let lo = minTs - 1;
    let hi = quickStart;
    for (let i = 0; i < 11 && hi - lo > 3600; i++) {
      const mid = Math.floor((lo + hi) / 2);
      const probe = await bucket.list({ prefix, startAfter: prefix + String(mid), limit: 1 });
      const p0 = probe.objects[0];
      if (p0 && isValidUpper(p0)) {
        const pt = extractPrefixTs(p0.key, prefix);
        lo = Math.max(mid, pt);
      } else {
        hi = mid;
      }
    }
    maxTs = Math.min(maxTs, hi + 60);
  } else if (!quick.truncated) {
    const matching = quickValid
      .map(serializeObj)
      .filter((o) => matchesFilters(o, fromMs, toMs, q, cat, imagesOnly));
    if (matching.length >= limit || quickStart <= minTs - 1) {
      matching.sort((a, b) => b.key.localeCompare(a.key));
      const sliced = matching.slice(0, limit);
      const hasMore = matching.length > limit || quickStart > minTs - 1;
      return { objects: sliced, folders, hasMore };
    }
  }

  // Gather tail objects before maxTs using adaptive window
  let win = q || cat ? 259200 : 36000;
  let winStart = Math.max(minTs - 1, maxTs - win);
  let collected: SerializedObj[] = [];

  for (let attempt = 0; attempt < 4; attempt++) {
    let batch: R2Object[] = [];
    let res = await bucket.list({ prefix, startAfter: prefix + String(winStart), limit: 1000 });
    batch.push(...res.objects.filter(isValidUpper));

    let pages = 1;
    while (res.truncated && res.cursor && pages < 4) {
      const last = res.objects[res.objects.length - 1];
      if (!last || extractPrefixTs(last.key, prefix) > maxTs || (beforeKey && last.key >= beforeKey)) {
        break;
      }
      res = await bucket.list({ prefix, cursor: res.cursor, limit: 1000 });
      batch.push(...res.objects.filter(isValidUpper));
      pages++;
    }

    // If still truncated before reaching maxTs, jump closer to maxTs
    if (res.truncated) {
      const last = res.objects[res.objects.length - 1];
      const lastTs = last ? extractPrefixTs(last.key, prefix) : 0;
      if (lastTs > 0 && lastTs < maxTs - 1800) {
        winStart = Math.floor((lastTs + maxTs) / 2);
        continue;
      }
    }

    collected = batch
      .map(serializeObj)
      .filter((o) => matchesFilters(o, fromMs, toMs, q, cat, imagesOnly));

    if (collected.length >= limit || winStart <= minTs - 1) {
      break;
    }
    win *= 6;
    winStart = attempt === 2 ? minTs - 1 : Math.max(minTs - 1, maxTs - win);
  }

  collected.sort((a, b) => b.key.localeCompare(a.key));
  const sliced = collected.slice(0, limit);
  const oldestKey = sliced[sliced.length - 1]?.key || '';
  const hasMore =
    collected.length > limit ||
    (winStart > minTs - 1 && oldestKey > firstObj.key);

  return { objects: sliced, folders, hasMore };
}

async function listPrefixOldest(
  bucket: R2Bucket,
  prefix: string,
  opts: {
    limit: number;
    fromMs: number;
    toMs: number;
    afterKey: string;
    cursor?: string;
    q: string;
    cat: string;
    imagesOnly: boolean;
  }
): Promise<{
  objects: SerializedObj[];
  folders: { prefix: string; name: string }[];
  hasMore: boolean;
  nextAfter: string | null;
}> {
  const { limit, fromMs, toMs, afterKey, q, cat, imagesOnly } = opts;
  const head = await bucket.list({ prefix, delimiter: '/', limit: 50 });
  const folders = (head.delimitedPrefixes || [])
    .filter((p) => p !== 'thumb/')
    .map((p) => ({
      prefix: p,
      name: p.replace(prefix, '').replace(/\/$/, ''),
    }));

  let startAfter: string | undefined = afterKey || undefined;
  if (!startAfter && fromMs > 0) {
    const firstObj = head.objects[0];
    const firstTs = firstObj ? extractPrefixTs(firstObj.key, prefix) : 0;
    if (firstTs > 0) {
      const fromSec = Math.floor(fromMs / 1000) - 600;
      if (fromSec > firstTs) startAfter = prefix + String(fromSec);
    }
  }

  const maxSec = toMs > 0 ? Math.floor(toMs / 1000) + 600 : 0;
  const collected: SerializedObj[] = [];
  let res = await bucket.list({ prefix, startAfter, limit: 1000 });
  let pages = 1;
  let passedUpper = false;

  while (true) {
    for (const o of res.objects) {
      if (maxSec > 0 && extractPrefixTs(o.key, prefix) > maxSec) {
        passedUpper = true;
        break;
      }
      const s = serializeObj(o);
      if (matchesFilters(s, fromMs, toMs, q, cat, imagesOnly)) {
        collected.push(s);
      }
    }
    if (passedUpper || collected.length >= limit + 1 || !res.truncated || !res.cursor || pages >= 4) {
      break;
    }
    res = await bucket.list({ prefix, cursor: res.cursor, limit: 1000 });
    pages++;
  }

  const sliced = collected.slice(0, limit);
  const lastRaw = res.objects[res.objects.length - 1];
  const nextAfter =
    collected.length > limit
      ? sliced[sliced.length - 1].key
      : !passedUpper && res.truncated && lastRaw
      ? lastRaw.key
      : null;

  return {
    objects: sliced,
    folders,
    hasMore: Boolean(nextAfter),
    nextAfter,
  };
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
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 180;
        const sort = url.searchParams.get('sort') || 'newest';
        const fromMs = parseInt(url.searchParams.get('from') || '0', 10) || 0;
        const toMs = parseInt(url.searchParams.get('to') || '0', 10) || 0;
        const beforeKey = url.searchParams.get('before') || '';
        const beforeTs = parseInt(url.searchParams.get('beforeTs') || '0', 10) || 0;
        const afterKey = url.searchParams.get('after') || '';
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        const cat = (url.searchParams.get('cat') || '').trim().toLowerCase();
        const imagesOnly = (url.searchParams.get('type') || 'images') === 'images';

        // If at root (''), list root folders and merge newest/oldest across top-level device folders
        if (!prefix) {
          const rootList = await env.BUCKET.list({ delimiter: '/', limit: 200 });
          const folders = (rootList.delimitedPrefixes || [])
            .filter((p) => p !== 'thumb/')
            .map((p) => ({ prefix: p, name: p.replace(/\/$/, '') }));

          const rootObjs = rootList.objects
            .map(serializeObj)
            .filter((o) => matchesFilters(o, fromMs, toMs, q, cat, imagesOnly));

          const targetPrefixes = folders.map((f) => f.prefix);
          if (sort === 'oldest') {
            const perFolderLimit = Math.max(60, Math.ceil(limit / Math.max(1, targetPrefixes.length)));
            const results = await Promise.all(
              targetPrefixes.map((p) =>
                listPrefixOldest(env.BUCKET, p, {
                  limit: perFolderLimit,
                  fromMs,
                  toMs,
                  afterKey: afterKey.startsWith(p) ? afterKey : '',
                  q,
                  cat,
                  imagesOnly,
                })
              )
            );
            const merged = [...rootObjs];
            let anyMore = false;
            for (const r of results) {
              merged.push(...r.objects);
              if (r.hasMore) anyMore = true;
            }
            merged.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
            const sliced = merged.slice(0, limit);
            const last = sliced[sliced.length - 1];
            return jsonResponse({
              objects: sliced,
              folders,
              truncated: anyMore || merged.length > limit,
              nextBefore: null,
              nextBeforeTs: 0,
              nextAfter: last ? last.key : null,
            });
          } else {
            const results = await Promise.all(
              targetPrefixes.map((p) =>
                listPrefixNewest(env.BUCKET, p, {
                  limit,
                  fromMs,
                  toMs,
                  beforeKey: beforeKey.startsWith(p) ? beforeKey : '',
                  beforeTs,
                  q,
                  cat,
                  imagesOnly,
                })
              )
            );
            const merged = [...rootObjs];
            let anyMore = false;
            for (const r of results) {
              merged.push(...r.objects);
              if (r.hasMore) anyMore = true;
            }
            merged.sort((a, b) => b.ts - a.ts || b.key.localeCompare(a.key));
            const sliced = merged.slice(0, limit);
            const last = sliced[sliced.length - 1];
            return jsonResponse({
              objects: sliced,
              folders,
              truncated: anyMore || merged.length > limit,
              nextBefore: last ? last.key : null,
              nextBeforeTs: last ? last.ts : 0,
              nextAfter: null,
            });
          }
        }

        if (sort === 'oldest') {
          const res = await listPrefixOldest(env.BUCKET, prefix, {
            limit,
            fromMs,
            toMs,
            afterKey,
            q,
            cat,
            imagesOnly,
          });
          return jsonResponse({
            objects: res.objects,
            folders: res.folders,
            truncated: res.hasMore,
            nextBefore: null,
            nextBeforeTs: 0,
            nextAfter: res.nextAfter,
          });
        }

        const res = await listPrefixNewest(env.BUCKET, prefix, {
          limit,
          fromMs,
          toMs,
          beforeKey,
          beforeTs,
          q,
          cat,
          imagesOnly,
        });
        const last = res.objects[res.objects.length - 1];
        return jsonResponse({
          objects: res.objects,
          folders: res.folders,
          truncated: res.hasMore,
          nextBefore: last ? last.key : null,
          nextBeforeTs: last ? last.ts : 0,
          nextAfter: null,
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
        const allKeysToDelete = [...body.keys];
        for (const k of body.keys) {
          if (!k.startsWith('thumb/')) allKeysToDelete.push('thumb/' + k);
        }
        try {
          for (let i = 0; i < allKeysToDelete.length; i += 900) {
            await env.BUCKET.delete(allKeysToDelete.slice(i, i + 900));
          }
        } catch (batchErr: any) {
          console.error('Batch delete failed:', batchErr.message || batchErr);
          const failed: string[] = [];
          for (let i = 0; i < body.keys.length; i++) {
            try {
              await env.BUCKET.delete(body.keys[i]);
              if (!body.keys[i].startsWith('thumb/')) {
                await env.BUCKET.delete('thumb/' + body.keys[i]).catch(() => {});
              }
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
        const wantThumb = url.searchParams.has('thumb') && !key.startsWith('thumb/');
        let object: R2ObjectBody | null = null;
        if (wantThumb) {
          object = await env.BUCKET.get('thumb/' + key);
        }
        if (!object) {
          object = await env.BUCKET.get(key);
        }

        if (!object) {
          return errorResponse('Not Found', 404);
        }

        const headers = new Headers(corsHeaders());
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('cache-control', 'public, max-age=604800, immutable');

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

const HTML = String.raw`<!DOCTYPE html>
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
  --bg:#0d1117;--surface:#161b22;--surface2:#21262d;--border:#30363d;
  --text:#e6edf3;--text-dim:#8b949e;--accent:#58a6ff;--danger:#f85149;--success:#3fb950;
  --cell-min:165px;--gap:8px;--transition:120ms ease;
}
body.light{
  --bg:#ffffff;--surface:#f6f8fa;--surface2:#eaeef2;--border:#d0d7de;
  --text:#1f2328;--text-dim:#59636e;--accent:#0969da;--danger:#cf222e;--success:#1a7f37;
}
body[data-density="s"]{--cell-min:110px;--gap:4px;}
body[data-density="m"]{--cell-min:165px;--gap:8px;}
body[data-density="l"]{--cell-min:230px;--gap:10px;}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  background:var(--bg);color:var(--text);min-height:100vh;line-height:1.45;
}
.header{
  position:sticky;top:0;z-index:100;background:var(--surface);
  border-bottom:1px solid var(--border);padding:10px 16px;display:flex;flex-direction:column;gap:8px;
}
.top-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.header h1{font-size:17px;font-weight:700;color:var(--accent);cursor:pointer;white-space:nowrap;}
.presets{display:flex;align-items:center;gap:4px;flex-wrap:wrap;}
.chip{
  padding:3px 9px;border:1px solid var(--border);border-radius:999px;
  background:var(--bg);color:var(--text-dim);font-size:12px;cursor:pointer;white-space:nowrap;
}
.chip:hover,.chip.active{border-color:var(--accent);color:var(--accent);background:var(--surface2);}
.actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap;}
.actions .count{font-size:12px;color:var(--text-dim);white-space:nowrap;margin-right:4px;}
.filters{display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%;}
.filters input,.filters select{
  padding:5px 8px;border:1px solid var(--border);border-radius:6px;
  background:var(--bg);color:var(--text);font-size:12.5px;outline:none;
}
.filters input:focus,.filters select:focus{border-color:var(--accent);}
.filters input[type="date"]{color-scheme:dark;width:126px;}
.filters input[type="time"]{color-scheme:dark;width:98px;}
.filters input[type="search"]{width:165px;}
.btn{
  padding:5px 11px;border:1px solid var(--border);border-radius:6px;
  background:var(--surface);color:var(--text);font-size:12.5px;cursor:pointer;
  transition:background var(--transition),border-color var(--transition);white-space:nowrap;
}
.btn:hover:not(:disabled){background:var(--surface2);border-color:var(--text-dim);}
.btn:disabled{opacity:.4;cursor:not-allowed;}
.btn-danger{border-color:var(--danger);color:var(--danger);}
.btn-danger:hover:not(:disabled){background:var(--danger);color:#fff;}
.btn-accent{border-color:var(--accent);color:var(--accent);}
.btn-accent:hover:not(:disabled){background:var(--accent);color:#fff;}
/* Breadcrumb & Folders Bar */
.subbar{
  padding:6px 16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  border-bottom:1px solid var(--border);background:var(--bg);min-height:34px;font-size:13px;
}
.breadcrumb{display:flex;align-items:center;gap:4px;flex-wrap:wrap;}
.breadcrumb a{color:var(--accent);text-decoration:none;cursor:pointer;padding:2px 6px;border-radius:4px;font-weight:500;}
.breadcrumb a:hover{background:var(--surface2);}
.breadcrumb .sep{color:var(--text-dim);}
.breadcrumb .current{color:var(--text);font-weight:600;padding:2px 4px;}
.folder-pills{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:8px;}
.folder-pill{
  display:inline-flex;align-items:center;gap:5px;padding:3px 10px;
  border:1px solid var(--border);border-radius:6px;background:var(--surface);
  color:var(--text);font-size:12px;cursor:pointer;
}
.folder-pill:hover,.folder-pill.active{border-color:var(--accent);color:var(--accent);}
.status-text{margin-left:auto;font-size:12px;color:var(--text-dim);}
/* Grid */
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(var(--cell-min),1fr));
  gap:var(--gap);padding:12px 16px;
}
.grid-item{
  position:relative;aspect-ratio:1;overflow:hidden;
  border-radius:6px;background:var(--surface);cursor:pointer;
  border:2px solid transparent;transition:border-color var(--transition);
  content-visibility:auto;contain-intrinsic-size:165px;
}
.grid-item:hover,.grid-item.selected{border-color:var(--accent);}
.grid-item img{width:100%;height:100%;object-fit:cover;display:block;background:var(--surface);}
.grid-item .file-icon{
  display:flex;align-items:center;justify-content:center;
  width:100%;height:100%;font-size:40px;color:var(--text-dim);
}
.grid-item .item-check{
  position:absolute;top:6px;left:6px;width:20px;height:20px;
  accent-color:var(--accent);cursor:pointer;z-index:2;opacity:0;transition:opacity var(--transition);
}
.grid-item:hover .item-check,.grid-item.selected .item-check,body.selection-mode .grid-item .item-check{opacity:1;}
.grid-item .badge{
  position:absolute;top:6px;right:6px;padding:1px 6px;border-radius:4px;
  background:rgba(0,0,0,.65);color:#fff;font-size:10px;pointer-events:none;
}
.grid-item .item-info{
  position:absolute;bottom:0;left:0;right:0;
  background:linear-gradient(transparent,rgba(0,0,0,.82));
  padding:20px 7px 5px;display:flex;flex-direction:column;gap:1px;
  opacity:0;transition:opacity var(--transition);pointer-events:none;
}
.grid-item:hover .item-info,body.selection-mode .grid-item .item-info{opacity:1;}
.grid-item .item-info span{
  font-size:11px;color:#e6edf3;text-shadow:0 1px 2px rgba(0,0,0,.9);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.grid-item .item-info span.meta{font-size:10px;opacity:.85;}
/* Empty & Loading */
.state-box{
  display:flex;align-items:center;justify-content:center;
  padding:60px 20px;color:var(--text-dim);font-size:14px;flex-direction:column;gap:10px;
}
.hidden{display:none!important;}
.spinner{
  width:30px;height:30px;border:3px solid var(--border);
  border-top-color:var(--accent);border-radius:50%;animation:spin .75s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}
.footer-more{text-align:center;padding:12px 16px 48px;}
/* Lightbox */
.lightbox{
  position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.94);
  display:flex;align-items:center;justify-content:center;
}
.lightbox-content{
  position:relative;max-width:94vw;max-height:92vh;
  display:flex;flex-direction:column;align-items:center;
}
.lightbox-content img{max-width:94vw;max-height:80vh;object-fit:contain;border-radius:4px;}
.lightbox-close{
  position:absolute;top:-38px;right:0;background:none;border:none;
  color:#fff;font-size:32px;cursor:pointer;line-height:1;padding:4px;
}
.lightbox-nav{
  position:absolute;top:50%;transform:translateY(-50%);
  background:rgba(255,255,255,.14);border:none;color:#fff;
  font-size:32px;cursor:pointer;padding:8px 14px;border-radius:4px;
}
.lightbox-nav:hover{background:rgba(255,255,255,.28);}
.lightbox-prev{left:-54px;}
.lightbox-next{right:-54px;}
.lightbox-toolbar{
  display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;justify-content:center;
}
.lightbox-toolbar span{font-size:12px;color:#c9d1d9;max-width:65vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lightbox-toolbar .btn{background:#161b22;color:#e6edf3;border-color:#484f58;}
/* Modal */
.modal-overlay{
  position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.7);
  display:flex;align-items:center;justify-content:center;
}
.modal{
  background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:22px;max-width:400px;width:90%;
}
.modal h2{font-size:17px;margin-bottom:8px;}
.modal p{font-size:13px;color:var(--text-dim);margin-bottom:18px;}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;}
/* Toast */
.toast{
  position:fixed;bottom:20px;right:20px;z-index:3000;
  padding:10px 16px;border-radius:8px;font-size:13px;max-width:340px;
}
.toast-success{background:#1a3a1a;border:1px solid var(--success);color:#7ee787;}
.toast-error{background:#3a1a1a;border:1px solid var(--danger);color:#ffa198;}
/* Selection Bar */
.selection-bar{
  position:fixed;bottom:0;left:0;right:0;z-index:500;
  background:var(--surface);border-top:1px solid var(--border);
  padding:10px 16px;display:flex;align-items:center;gap:8px;
  transform:translateY(100%);transition:transform .2s ease;
}
.selection-bar.active{transform:translateY(0);}
.selection-bar .sel-count{font-size:13px;color:var(--text-dim);margin-right:auto;}
body.selection-mode{padding-bottom:60px;}
@media(max-width:768px){
  .header{padding:8px 10px;}
  .grid{padding:8px 10px;}
  body[data-density="m"]{--cell-min:120px;--gap:4px;}
  .filters input,.filters select{font-size:15px;padding:6px 8px;}
  .grid-item .item-check{opacity:1;width:24px;height:24px;top:4px;left:4px;}
  .grid-item .item-info{opacity:1;}
  .lightbox-prev{left:4px;}
  .lightbox-next{right:4px;}
  .lightbox-nav{font-size:24px;padding:6px 10px;}
}
</style>
</head>
<body data-density="m">

<header class="header">
  <div class="top-row">
    <h1 id="homeTitle">R2 Browser</h1>
    <div class="presets" id="presets">
      <button class="chip active" data-range="all">All Time</button>
      <button class="chip" data-range="1h">Last 1h</button>
      <button class="chip" data-range="24h">Last 24h</button>
      <button class="chip" data-range="7d">Last 7d</button>
      <button class="chip" data-range="30d">Last 30d</button>
    </div>
    <div class="actions">
      <span class="count" id="countLabel">0 items</span>
      <button class="btn" id="themeBtn" title="Toggle Light/Dark">Theme</button>
      <button class="btn" id="refreshBtn">Refresh</button>
      <button class="btn" id="selectAllBtn">Select All</button>
      <button class="btn btn-accent" id="downloadBtn" disabled>Download</button>
      <button class="btn btn-danger" id="deleteBtn" disabled>Delete</button>
    </div>
  </div>
  <div class="filters">
    <input type="search" id="searchInput" placeholder="Search filename (/)" autocomplete="off">
    <select id="catFilter" title="Filter by app/source">
      <option value="">All Apps</option>
      <option value="whatsapp">WhatsApp</option>
      <option value="instagram">Instagram</option>
      <option value="messenger">Messenger</option>
      <option value="snapchat">Snapchat</option>
      <option value="screenshot">Screenshots</option>
      <option value="camera">Camera</option>
    </select>
    <input type="date" id="dateFrom" title="From date">
    <input type="time" id="timeFrom" title="From time" step="60">
    <input type="date" id="dateTo" title="To date">
    <input type="time" id="timeTo" title="To time" step="60">
    <select id="sortFilter" title="Sort order">
      <option value="newest">Newest First</option>
      <option value="oldest">Oldest First</option>
      <option value="size">Largest First</option>
      <option value="smallest">Smallest First</option>
      <option value="name">Name A-Z</option>
    </select>
    <select id="typeFilter">
      <option value="images" selected>Images Only</option>
      <option value="all">All Files</option>
    </select>
    <select id="densityFilter" title="Grid size">
      <option value="s">Small Grid</option>
      <option value="m" selected>Medium Grid</option>
      <option value="l">Large Grid</option>
    </select>
    <button class="btn" id="clearFiltersBtn">Reset</button>
  </div>
</header>

<div class="subbar">
  <div class="breadcrumb" id="breadcrumb"></div>
  <div class="folder-pills" id="folderPills"></div>
  <span class="status-text" id="statusText">Ready</span>
</div>

<main id="grid" class="grid"></main>

<div id="emptyState" class="state-box hidden">
  <div style="font-size:42px;opacity:.4">&#128247;</div>
  <span id="emptyMsg">No matching files found</span>
</div>

<div id="loadingState" class="state-box hidden">
  <div class="spinner"></div>
  <span>Loading newest files...</span>
</div>

<div class="footer-more">
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
      <button class="btn" id="lightboxCopy">Copy Link</button>
      <button class="btn" id="lightboxDownload">Download</button>
      <button class="btn btn-danger" id="lightboxDelete">Delete</button>
    </div>
  </div>
</div>

<div id="deleteModal" class="modal-overlay hidden">
  <div class="modal">
    <h2>Delete Files</h2>
    <p>Permanently delete <strong id="deleteCount">0</strong> selected file(s)?</p>
    <div class="modal-actions">
      <button class="btn" id="deleteCancel">Cancel</button>
      <button class="btn btn-danger" id="deleteConfirm">Delete</button>
    </div>
  </div>
</div>

<div class="selection-bar" id="selectionBar">
  <span class="sel-count" id="selectionCount">0 selected</span>
  <button class="btn" id="selectionCancel">Cancel</button>
  <button class="btn btn-accent" id="selectionDownload">Download</button>
  <button class="btn btn-danger" id="selectionDelete">Delete</button>
</div>

<script>
(function(){
  'use strict';
  var LS = 'r2browser:v3';
  var state = {
    prefix: '',
    objects: [],
    view: [],
    folders: [],
    selected: {},
    nextBefore: null,
    nextBeforeTs: 0,
    nextAfter: null,
    hasMore: false,
    loading: false,
    lightboxIdx: -1,
    lastClickedIdx: -1,
    selectionMode: false,
    theme: 'dark',
    density: 'm',
    reqId: 0
  };
  var seenKeys = {};

  var $ = function(id){ return document.getElementById(id); };
  var grid = $('grid'), emptyState = $('emptyState'), emptyMsg = $('emptyMsg');
  var loadingState = $('loadingState'), loadMoreBtn = $('loadMoreBtn'), statusText = $('statusText');
  var countLabel = $('countLabel'), downloadBtn = $('downloadBtn'), deleteBtn = $('deleteBtn');
  var selectAllBtn = $('selectAllBtn'), refreshBtn = $('refreshBtn'), themeBtn = $('themeBtn');
  var searchInput = $('searchInput'), catFilter = $('catFilter');
  var dateFrom = $('dateFrom'), timeFrom = $('timeFrom'), dateTo = $('dateTo'), timeTo = $('timeTo');
  var sortFilter = $('sortFilter'), typeFilter = $('typeFilter'), densityFilter = $('densityFilter');
  var clearFiltersBtn = $('clearFiltersBtn'), breadcrumb = $('breadcrumb'), folderPills = $('folderPills');
  var lightbox = $('lightbox'), lightboxImage = $('lightboxImage');
  var lightboxFilename = $('lightboxFilename'), lightboxMeta = $('lightboxMeta');
  var deleteModal = $('deleteModal'), deleteCount = $('deleteCount');
  var selectionBar = $('selectionBar'), selectionCount = $('selectionCount');

  function savePrefs() {
    try {
      localStorage.setItem(LS, JSON.stringify({
        theme: state.theme,
        density: state.density,
        sort: sortFilter.value,
        type: typeFilter.value
      }));
    } catch (e) {}
  }

  function loadPrefs() {
    try {
      var d = JSON.parse(localStorage.getItem(LS) || '{}') || {};
      if (d.theme) state.theme = d.theme;
      if (d.density) state.density = d.density;
      if (d.sort) sortFilter.value = d.sort;
      if (d.type) typeFilter.value = d.type;
    } catch (e) {}
    var h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (h) state.prefix = h.endsWith('/') ? h : h + '/';
    document.body.classList.toggle('light', state.theme === 'light');
    document.body.setAttribute('data-density', state.density);
    densityFilter.value = state.density;
  }

  function parseBound(dateVal, timeVal, isEnd) {
    if (!dateVal) return 0;
    var dp = dateVal.split('-');
    var tp = (timeVal || (isEnd ? '23:59' : '00:00')).split(':');
    var d = new Date(
      parseInt(dp[0], 10),
      parseInt(dp[1], 10) - 1,
      parseInt(dp[2], 10),
      parseInt(tp[0] || '0', 10),
      parseInt(tp[1] || '0', 10),
      isEnd ? 59 : 0,
      isEnd ? 999 : 0
    );
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function formatSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  function formatDate(msOrIso) {
    var d = new Date(msOrIso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function thumbUrl(key) {
    return '/api/objects/' + encodeURIComponent(key) + '?thumb=1';
  }

  function fullUrl(key) {
    return '/api/objects/' + encodeURIComponent(key);
  }

  function selCount() {
    return Object.keys(state.selected).length;
  }

  function updateToolbar() {
    var sel = selCount();
    countLabel.textContent = state.view.length + (state.hasMore ? '+' : '') + ' items' + (sel ? ' (' + sel + ' sel)' : '');
    downloadBtn.disabled = sel === 0;
    deleteBtn.disabled = sel === 0;
    selectionCount.textContent = sel + ' selected';
    loadMoreBtn.style.display = state.hasMore && !state.loading ? '' : 'none';
  }

  function renderSubbar() {
    breadcrumb.innerHTML = '';
    var rootLink = document.createElement('a');
    rootLink.textContent = 'All Folders';
    if (!state.prefix) rootLink.className = 'current';
    rootLink.addEventListener('click', function(){ navigateToFolder(''); });
    breadcrumb.appendChild(rootLink);

    if (state.prefix) {
      var parts = state.prefix.split('/').filter(Boolean);
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
          (function(target, label){
            var a = document.createElement('a');
            a.textContent = label;
            a.addEventListener('click', function(){ navigateToFolder(target); });
            breadcrumb.appendChild(a);
          })(acc, parts[i]);
        }
      }
    }

    folderPills.innerHTML = '';
    for (var f = 0; f < state.folders.length; f++) {
      (function(folder){
        var pill = document.createElement('button');
        pill.className = 'folder-pill' + (state.prefix === folder.prefix ? ' active' : '');
        pill.innerHTML = '&#128193; ' + folder.name;
        pill.addEventListener('click', function(){ navigateToFolder(folder.prefix); });
        folderPills.appendChild(pill);
      })(state.folders[f]);
    }
  }

  function navigateToFolder(prefix) {
    if (prefix && !prefix.endsWith('/')) prefix += '/';
    state.prefix = prefix;
    location.hash = prefix ? '#' + encodeURIComponent(prefix) : '';
    fetchObjects(false);
  }

  function sortViewList(list) {
    var s = sortFilter.value;
    var copy = list.slice();
    if (s === 'newest') copy.sort(function(a, b){ return (b.ts || 0) - (a.ts || 0) || b.key.localeCompare(a.key); });
    else if (s === 'oldest') copy.sort(function(a, b){ return (a.ts || 0) - (b.ts || 0) || a.key.localeCompare(b.key); });
    else if (s === 'size') copy.sort(function(a, b){ return b.size - a.size; });
    else if (s === 'smallest') copy.sort(function(a, b){ return a.size - b.size; });
    else if (s === 'name') copy.sort(function(a, b){ return a.key.localeCompare(b.key); });
    return copy;
  }

  function applyLocalSortAndFilter(rebuildDom) {
    var q = searchInput.value.trim().toLowerCase();
    var cat = catFilter.value.toLowerCase();
    var imgsOnly = typeFilter.value === 'images';
    var filtered = state.objects.filter(function(o){
      if (imgsOnly && !o.isImage) return false;
      if (cat && o.key.toLowerCase().indexOf(cat) < 0) return false;
      if (q && o.key.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    state.view = sortViewList(filtered);
    if (rebuildDom) {
      grid.innerHTML = '';
      appendItemsToDom(state.view, 0);
    }
    emptyState.classList.toggle('hidden', state.view.length > 0 || state.loading);
    updateToolbar();
  }

  function createGridCard(obj, idx) {
    var item = document.createElement('div');
    item.className = 'grid-item' + (state.selected[obj.key] ? ' selected' : '');
    item.dataset.key = obj.key;
    item.dataset.index = String(idx);

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'item-check';
    cb.checked = !!state.selected[obj.key];
    cb.addEventListener('click', function(e){
      e.stopPropagation();
      var cardIdx = parseInt(item.dataset.index, 10);
      if (e.shiftKey && state.lastClickedIdx >= 0) {
        rangeSelect(state.lastClickedIdx, cardIdx);
        return;
      }
      toggleSelect(obj.key, cb.checked, item);
      state.lastClickedIdx = cardIdx;
    });
    item.appendChild(cb);

    if (!state.prefix && obj.key.indexOf('/') > 0) {
      var badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = obj.key.split('/')[0];
      item.appendChild(badge);
    }

    if (obj.isImage) {
      var img = document.createElement('img');
      img.src = thumbUrl(obj.key);
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = obj.key;
      img.addEventListener('error', function(){
        if (img.dataset.retried) {
          img.style.display = 'none';
          return;
        }
        img.dataset.retried = '1';
        img.src = fullUrl(obj.key);
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
    var metaSpan = document.createElement('span');
    metaSpan.className = 'meta';
    metaSpan.textContent = formatSize(obj.size) + ' \u00b7 ' + formatDate(obj.ts || obj.uploaded);
    info.appendChild(nameSpan);
    info.appendChild(metaSpan);
    item.appendChild(info);

    item.addEventListener('click', function(e){
      if (e.target.tagName === 'INPUT') return;
      var cardIdx = parseInt(item.dataset.index, 10);
      if (state.selectionMode) {
        e.preventDefault();
        toggleSelect(obj.key, !state.selected[obj.key], item);
        return;
      }
      if (e.shiftKey && state.lastClickedIdx >= 0) {
        e.preventDefault();
        rangeSelect(state.lastClickedIdx, cardIdx);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        toggleSelect(obj.key, !state.selected[obj.key], item);
        state.lastClickedIdx = cardIdx;
        return;
      }
      state.lastClickedIdx = cardIdx;
      openLightbox(cardIdx);
    });

    var lpTimer = null;
    item.addEventListener('touchstart', function(){
      lpTimer = setTimeout(function(){
        enterSelectionMode();
        toggleSelect(obj.key, true, item);
        if (navigator.vibrate) navigator.vibrate(20);
      }, 480);
    }, { passive: true });
    item.addEventListener('touchend', function(){ clearTimeout(lpTimer); });
    item.addEventListener('touchmove', function(){ clearTimeout(lpTimer); });

    return item;
  }

  function appendItemsToDom(items, startIndex) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      frag.appendChild(createGridCard(items[i], startIndex + i));
    }
    grid.appendChild(frag);
  }

  async function fetchObjects(append) {
    if (state.loading && append) return;
    var myReq = ++state.reqId;
    state.loading = true;
    var t0 = performance.now();

    if (!append) {
      state.objects = [];
      state.view = [];
      state.selected = {};
      state.nextBefore = null;
      state.nextBeforeTs = 0;
      state.nextAfter = null;
      seenKeys = {};
      grid.innerHTML = '';
      emptyState.classList.add('hidden');
    }
    loadingState.classList.remove('hidden');
    loadMoreBtn.style.display = 'none';
    statusText.textContent = 'Loading...';

    var serverSort = sortFilter.value === 'oldest' ? 'oldest' : 'newest';
    var fromMs = parseBound(dateFrom.value, timeFrom.value, false);
    var toMs = parseBound(dateTo.value, timeTo.value, true);

    var params = new URLSearchParams();
    params.set('limit', '180');
    params.set('sort', serverSort);
    params.set('type', typeFilter.value);
    if (state.prefix) params.set('prefix', state.prefix);
    if (fromMs) params.set('from', String(fromMs));
    if (toMs) params.set('to', String(toMs));
    if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
    if (catFilter.value) params.set('cat', catFilter.value);

    if (append) {
      if (serverSort === 'oldest' && state.nextAfter) {
        params.set('after', state.nextAfter);
      } else if (serverSort === 'newest') {
        if (state.nextBefore) params.set('before', state.nextBefore);
        if (state.nextBeforeTs) params.set('beforeTs', String(state.nextBeforeTs));
      }
    }

    try {
      var resp = await fetch('/api/objects?' + params.toString());
      if (myReq !== state.reqId) return;
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      if (myReq !== state.reqId) return;

      if (!append || state.folders.length === 0) {
        state.folders = data.folders || [];
      }
      var incoming = data.objects || [];
      var newItems = [];
      for (var i = 0; i < incoming.length; i++) {
        var o = incoming[i];
        if (!seenKeys[o.key]) {
          seenKeys[o.key] = 1;
          state.objects.push(o);
          newItems.push(o);
        }
      }

      state.nextBefore = data.nextBefore || null;
      state.nextBeforeTs = data.nextBeforeTs || 0;
      state.nextAfter = data.nextAfter || null;
      state.hasMore = !!data.truncated;

      var sortMode = sortFilter.value;
      if (append && (sortMode === 'newest' || sortMode === 'oldest')) {
        var startIdx = state.view.length;
        for (var j = 0; j < newItems.length; j++) state.view.push(newItems[j]);
        appendItemsToDom(newItems, startIdx);
      } else {
        applyLocalSortAndFilter(true);
      }

      var ms = Math.round(performance.now() - t0);
      statusText.textContent = 'Loaded ' + state.view.length + ' in ' + ms + 'ms';
      renderSubbar();
    } catch (err) {
      if (myReq !== state.reqId) return;
      statusText.textContent = 'Error loading files';
      showToast('Failed to load: ' + err.message, 'error');
    } finally {
      if (myReq === state.reqId) {
        state.loading = false;
        loadingState.classList.add('hidden');
        emptyState.classList.toggle('hidden', state.view.length > 0);
        updateToolbar();
      }
    }
  }

  function toggleSelect(key, checked, cardEl) {
    if (checked) state.selected[key] = true;
    else delete state.selected[key];
    if (cardEl) {
      cardEl.classList.toggle('selected', !!checked);
      var cb = cardEl.querySelector('.item-check');
      if (cb) cb.checked = !!checked;
    }
    updateToolbar();
  }

  function syncSelectionDom() {
    var cards = grid.querySelectorAll('.grid-item');
    for (var i = 0; i < cards.length; i++) {
      var k = cards[i].dataset.key;
      var isSel = !!state.selected[k];
      cards[i].classList.toggle('selected', isSel);
      var cb = cards[i].querySelector('.item-check');
      if (cb) cb.checked = isSel;
    }
    updateToolbar();
  }

  function rangeSelect(fromIdx, toIdx) {
    var lo = Math.min(fromIdx, toIdx);
    var hi = Math.max(fromIdx, toIdx);
    for (var i = lo; i <= hi && i < state.view.length; i++) {
      state.selected[state.view[i].key] = true;
    }
    syncSelectionDom();
  }

  function enterSelectionMode() {
    if (state.selectionMode) return;
    state.selectionMode = true;
    document.body.classList.add('selection-mode');
    selectionBar.classList.add('active');
    updateToolbar();
  }

  function exitSelectionMode() {
    state.selectionMode = false;
    document.body.classList.remove('selection-mode');
    selectionBar.classList.remove('active');
    state.selected = {};
    syncSelectionDom();
  }

  function openLightbox(idx) {
    if (idx < 0 || idx >= state.view.length) return;
    state.lightboxIdx = idx;
    var obj = state.view[idx];
    lightbox.classList.remove('hidden');
    lightboxImage.src = fullUrl(obj.key);
    lightboxFilename.textContent = obj.key;
    lightboxMeta.textContent = formatSize(obj.size) + ' \u00b7 ' + formatDate(obj.ts || obj.uploaded) + ' \u00b7 ' + (idx + 1) + '/' + state.view.length;
    document.body.style.overflow = 'hidden';

    if (idx + 1 < state.view.length && state.view[idx + 1].isImage) {
      var preNext = new Image();
      preNext.src = fullUrl(state.view[idx + 1].key);
    }
    if (idx + 3 >= state.view.length && state.hasMore && !state.loading) {
      fetchObjects(true);
    }
  }

  function closeLightbox() {
    lightbox.classList.add('hidden');
    lightboxImage.removeAttribute('src');
    document.body.style.overflow = '';
  }

  function navigateLightbox(dir) {
    if (!state.view.length) return;
    var next = state.lightboxIdx + dir;
    if (next < 0) next = state.view.length - 1;
    if (next >= state.view.length) next = 0;
    openLightbox(next);
  }

  function downloadSingle(key) {
    var a = document.createElement('a');
    a.href = fullUrl(key) + '?download=1';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function loadScript(src) {
    return new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function downloadSelected() {
    var keys = Object.keys(state.selected);
    if (!keys.length) return;
    if (keys.length === 1) {
      downloadSingle(keys[0]);
      return;
    }
    var toast = showToast('Preparing ZIP (' + keys.length + ' files)...', 'success');
    try {
      if (!window.JSZip) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
      }
      var zip = new window.JSZip();
      await Promise.all(keys.map(function(key){
        return fetch(fullUrl(key)).then(function(r){ return r.blob(); }).then(function(blob){
          zip.file(key.split('/').pop() || key, blob);
        });
      }));
      var content = await zip.generateAsync({ type: 'blob' });
      var u = URL.createObjectURL(content);
      var a = document.createElement('a');
      a.href = u;
      a.download = 'r2-download.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function(){ URL.revokeObjectURL(u); }, 5000);
      if (toast) toast.remove();
      showToast('Downloaded ' + keys.length + ' files', 'success');
    } catch (err) {
      if (toast) toast.remove();
      showToast('Download failed: ' + err.message, 'error');
    }
  }

  function showDeleteModal() {
    var n = selCount();
    if (!n) return;
    deleteCount.textContent = String(n);
    deleteModal.classList.remove('hidden');
  }

  async function confirmDelete() {
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
      var delMap = {};
      for (var i = 0; i < keys.length; i++) delMap[keys[i]] = 1;
      state.objects = state.objects.filter(function(o){ return !delMap[o.key]; });
      exitSelectionMode();
      applyLocalSortAndFilter(true);
      showToast('Deleted ' + keys.length + ' file(s)', 'success');
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

  // Event Listeners
  $('homeTitle').addEventListener('click', function(){ navigateToFolder(''); });
  refreshBtn.addEventListener('click', function(){ fetchObjects(false); });
  loadMoreBtn.addEventListener('click', function(){ fetchObjects(true); });

  themeBtn.addEventListener('click', function(){
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.body.classList.toggle('light', state.theme === 'light');
    savePrefs();
  });

  densityFilter.addEventListener('change', function(){
    state.density = densityFilter.value;
    document.body.setAttribute('data-density', state.density);
    savePrefs();
  });

  sortFilter.addEventListener('change', function(){
    savePrefs();
    var s = sortFilter.value;
    if (s === 'newest' || s === 'oldest') {
      fetchObjects(false);
    } else {
      applyLocalSortAndFilter(true);
    }
  });

  typeFilter.addEventListener('change', function(){
    savePrefs();
    fetchObjects(false);
  });

  catFilter.addEventListener('change', function(){
    fetchObjects(false);
  });

  var searchTimer = null;
  searchInput.addEventListener('input', function(){
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){
      fetchObjects(false);
    }, 220);
  });

  function onDateChange() {
    setActivePreset('');
    fetchObjects(false);
  }
  dateFrom.addEventListener('change', onDateChange);
  timeFrom.addEventListener('change', onDateChange);
  dateTo.addEventListener('change', onDateChange);
  timeTo.addEventListener('change', onDateChange);

  function setActivePreset(range) {
    var chips = document.querySelectorAll('#presets .chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].classList.toggle('active', chips[i].dataset.range === range);
    }
  }

  function toLocalDateStr(d) {
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  function toLocalTimeStr(d) {
    var h = d.getHours();
    var min = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (min < 10 ? '0' : '') + min;
  }

  $('presets').addEventListener('click', function(e){
    var btn = e.target.closest('.chip');
    if (!btn) return;
    var range = btn.dataset.range;
    setActivePreset(range);
    dateTo.value = '';
    timeTo.value = '';
    if (range === 'all') {
      dateFrom.value = '';
      timeFrom.value = '';
    } else {
      var ms = range === '1h' ? 3600000 : range === '24h' ? 86400000 : range === '7d' ? 604800000 : 2592000000;
      var fromDate = new Date(Date.now() - ms);
      dateFrom.value = toLocalDateStr(fromDate);
      timeFrom.value = toLocalTimeStr(fromDate);
    }
    fetchObjects(false);
  });

  clearFiltersBtn.addEventListener('click', function(){
    searchInput.value = '';
    catFilter.value = '';
    dateFrom.value = '';
    timeFrom.value = '';
    dateTo.value = '';
    timeTo.value = '';
    sortFilter.value = 'newest';
    setActivePreset('all');
    fetchObjects(false);
  });

  selectAllBtn.addEventListener('click', function(){
    if (selCount() >= state.view.length && state.view.length > 0) {
      state.selected = {};
    } else {
      for (var i = 0; i < state.view.length; i++) {
        state.selected[state.view[i].key] = true;
      }
    }
    syncSelectionDom();
  });

  downloadBtn.addEventListener('click', downloadSelected);
  deleteBtn.addEventListener('click', showDeleteModal);
  $('deleteCancel').addEventListener('click', function(){ deleteModal.classList.add('hidden'); });
  $('deleteConfirm').addEventListener('click', confirmDelete);
  deleteModal.addEventListener('click', function(e){ if (e.target === deleteModal) deleteModal.classList.add('hidden'); });

  $('selectionCancel').addEventListener('click', exitSelectionMode);
  $('selectionDownload').addEventListener('click', function(){ downloadSelected(); exitSelectionMode(); });
  $('selectionDelete').addEventListener('click', showDeleteModal);

  $('lightboxClose').addEventListener('click', closeLightbox);
  $('lightboxPrev').addEventListener('click', function(){ navigateLightbox(-1); });
  $('lightboxNext').addEventListener('click', function(){ navigateLightbox(1); });
  lightbox.addEventListener('click', function(e){ if (e.target === lightbox) closeLightbox(); });

  var touchX = 0, touchY = 0;
  lightbox.addEventListener('touchstart', function(e){
    if (e.touches.length === 1) {
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
    }
  }, { passive: true });
  lightbox.addEventListener('touchend', function(e){
    var dx = e.changedTouches[0].clientX - touchX;
    var dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
      navigateLightbox(dx < 0 ? 1 : -1);
    }
  });

  $('lightboxCopy').addEventListener('click', function(){
    var obj = state.view[state.lightboxIdx];
    if (!obj) return;
    var u = location.origin + fullUrl(obj.key);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(u).then(function(){ showToast('Link copied', 'success'); });
    }
  });

  $('lightboxDownload').addEventListener('click', function(){
    var obj = state.view[state.lightboxIdx];
    if (obj) downloadSingle(obj.key);
  });

  $('lightboxDelete').addEventListener('click', function(){
    var obj = state.view[state.lightboxIdx];
    if (!obj) return;
    state.selected = {};
    state.selected[obj.key] = true;
    syncSelectionDom();
    closeLightbox();
    showDeleteModal();
  });

  // Infinite scroll
  window.addEventListener('scroll', function(){
    if (!state.hasMore || state.loading) return;
    var doc = document.documentElement;
    if (window.pageYOffset + window.innerHeight + 700 >= doc.scrollHeight) {
      fetchObjects(true);
    }
  }, { passive: true });

  document.addEventListener('keydown', function(e){
    var inInput = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement ? document.activeElement.tagName : '');
    if (e.key === '/' && !inInput) {
      e.preventDefault();
      searchInput.focus();
      return;
    }
    if (!lightbox.classList.contains('hidden')) {
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') navigateLightbox(-1);
      if (e.key === 'ArrowRight') navigateLightbox(1);
      return;
    }
    if (e.key === 'Escape') {
      if (inInput) { document.activeElement.blur(); return; }
      if (!deleteModal.classList.contains('hidden')) { deleteModal.classList.add('hidden'); return; }
      if (state.selectionMode) exitSelectionMode();
    }
    if (!inInput && (e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      for (var i = 0; i < state.view.length; i++) state.selected[state.view[i].key] = true;
      syncSelectionDom();
    }
  });

  // Init
  loadPrefs();
  renderSubbar();
  fetchObjects(false);
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

const SW = String.raw`
const CACHE = 'r2browser-v3';
const ASSETS = ['/manifest.json', '/icon.svg'];

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

  // Always network-first for HTML shell and API list so updates are immediate
  if (url.pathname === '/' || url.pathname === '/api/objects') {
    e.respondWith(
      fetch(req).catch(function() { return caches.match(req); })
    );
    return;
  }

  // Cache-first for immutable image/thumb objects and static icons
  e.respondWith(
    caches.match(req).then(function(cached) {
      if (cached) return cached;
      return fetch(req).then(function(resp) {
        if (resp.ok) {
          var clone = resp.clone();
          caches.open(CACHE).then(function(c) { c.put(req, clone); });
        }
        return resp;
      });
    })
  );
});
`;
