#!/usr/bin/env python3
"""
R2 Browser - AI index builder (Option B: thumbs-only local indexing).

Downloads only the ~20KB thumbnails from your R2 bucket, runs face detection +
clustering (InsightFace) and zero-shot tagging (CLIP) locally on your GPU/CPU,
then uploads a compact index that the R2 Browser web app reads for
face filtering, AI tag search and colour filtering.

Why thumbs only:
    ~69k full images would be ~15GB and hours to download and embed.
    ~69k thumbnails are ~1.5GB, download fast, and are plenty of signal for
    face clustering + CLIP tagging.

Usage:
    pip install requests pillow numpy torch transformers insightface onnxruntime scikit-learn

    python tools/ai_index.py --limit 500                  # small smoke test
    python tools/ai_index.py                              # full run
    python tools/ai_index.py --upload                     # build + push to R2
    python tools/ai_index.py --upload --resume            # incremental re-run

Re-runs are incremental: already-processed keys are skipped via out/cache/state.json,
so you can re-run it daily as new captures land in R2.
"""

import argparse
import gzip
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"
CACHE = OUT / "cache"
THUMBS = CACHE / "thumbs"
STATE = CACHE / "state.json"

SKIP_PREFIXES = ("thumb/", "index/", ".wrangler/")

# Zero-shot CLIP prompt vocabulary. Photo-domain, deliberately generic so it
# generalises beyond the app names already present in your filenames.
TAGS = [
    "a photo of one person", "a photo of a group of people", "a selfie",
    "a photo of a child", "a photo of a dog", "a photo of a cat",
    "a photo of an animal", "a photo of food or a meal", "a photo of a drink",
    "a photo of a car or vehicle", "a photo of the inside of a vehicle",
    "a photo of a document or sheet of paper", "a photo of a receipt or invoice",
    "a photo of an id card or passport", "a photo of a banknote or credit card",
    "a screenshot of a messaging app", "a screenshot of a social media feed",
    "a screenshot of a phone home screen", "a screenshot of a settings screen",
    "a photo of a computer screen", "a photo of a video game",
    "a photo of a book or magazine", "a photo of printed text",
    "a photo of a landscape", "a photo of the beach or ocean", "a photo of the sky",
    "a photo of a building", "a photo of a room indoors", "a photo of furniture",
    "a photo of plants or nature", "a photo of water",
    "a photo of a road or street", "a photo of a wall or floor",
    "a photo of clothing", "a photo of shoes", "a photo of jewelry",
    "a photo of a watch", "a photo of a mobile phone", "a photo of a computer",
    "a cartoon, drawing or illustration", "a blurry or out of focus photo",
    "a photo taken at night", "a photo taken in daylight",
    "a photo of a bright colourful scene", "a dark low light photo",
    "a black and white photo", "a photo of a toy", "a photo of music or instruments",
    "a photo of a sports or fitness activity", "a photo of a gift or present",
]

COLOR_PALETTE = [
    ("black", (0, 0, 0)), ("white", (255, 255, 255)), ("gray", (128, 128, 128)),
    ("red", (220, 40, 40)), ("orange", (240, 140, 30)), ("yellow", (245, 220, 60)),
    ("green", (60, 180, 80)), ("teal", (40, 180, 180)), ("blue", (50, 110, 230)),
    ("purple", (150, 80, 220)), ("pink", (245, 140, 190)), ("brown", (140, 95, 50)),
]
COLOR_DIST_THRESHOLD = 62


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def read_bucket_name():
    toml = (ROOT / "wrangler.toml").read_text(encoding="utf-8")
    m = re.search(r'bucket_name\s*=\s*"([^"]+)"', toml)
    return m.group(1) if m else "parental-media"


# --------------------------------------------------------------------------
# 1. enumerate every image key via the worker API
# --------------------------------------------------------------------------
def enumerate_keys(endpoint, limit, folders_filter=None):
    session = requests.Session()
    session.headers.update({"User-Agent": "r2-browser-ai-index/1"})

    root = session.get(f"{endpoint}/api/objects?limit=1", timeout=60).json()
    folders = [f["prefix"] for f in root.get("folders", [])]
    folders = [f for f in folders if not f.startswith(SKIP_PREFIXES)]
    if folders_filter:
        folders = [f for f in folders if any(f.startswith(p) for p in folders_filter)]
    if not folders:
        folders = [""]
    log(f"folders: {folders}")

    all_items = []
    for prefix in folders:
        before, before_ts = None, 0
        page = 0
        while True:
            params = {"limit": "500", "sort": "newest", "type": "all"}
            if prefix:
                params["prefix"] = prefix
            if before:
                params["before"] = before
                params["beforeTs"] = str(before_ts)
            data = session.get(f"{endpoint}/api/objects", params=params, timeout=120).json()
            objs = data.get("objects", [])
            for o in objs:
                if o["key"].startswith(SKIP_PREFIXES):
                    continue
                o["prefix"] = prefix
                all_items.append(o)
            page += 1
            if page % 10 == 0:
                log(f"  {prefix or '/'} enumerated {len(all_items)}")
            before = data.get("nextBefore")
            before_ts = data.get("nextBeforeTs") or 0
            if not before:
                break

    all_items.sort(key=lambda o: o["key"])
    if limit:
        all_items = all_items[:limit]
    log(f"total objects: {len(all_items)}")
    return all_items


# --------------------------------------------------------------------------
# 2. download thumbnails (resume-able, threaded)
# --------------------------------------------------------------------------
def thumb_cache_path(key):
    import hashlib
    h = hashlib.sha1(key.encode()).hexdigest()
    return THUMBS / h[:2] / f"{h}.jpg"


def download_one(session, endpoint, key, lock_stats):
    dest = thumb_cache_path(key)
    if dest.exists() and dest.stat().st_size > 0:
        with lock_stats:
            lock_stats["cached"] += 1
        return key, dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"{endpoint}/api/objects/{requests.utils.quote(key, safe='')}?thumb=1"
    try:
        r = session.get(url, timeout=90)
        if r.status_code != 200 or not r.content:
            raise RuntimeError(f"HTTP {r.status_code}")
        tmp = dest.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.rename(dest)
        with lock_stats:
            lock_stats["downloaded"] += 1
        return key, dest
    except Exception as e:
        with lock_stats:
            lock_stats["failed"] += 1
        return key, None


def download_thumbs(endpoint, items, workers):
    log(f"downloading thumbnails with {workers} threads ...")
    THUMBS.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    stats = {"cached": 0, "downloaded": 0, "failed": 0}
    lock = __import__("threading").Lock()
    paths = {}
    done = 0
    total = len(items)
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(download_one, session, endpoint, it["key"], lock) for it in items]
        for fut in futures:
            key, dest = fut.result()
            if dest:
                paths[key] = dest
            done += 1
            if done % 500 == 0:
                rate = done / max(1e-6, time.time() - t0)
                log(f"  {done}/{total} thumbs ({rate:.0f}/s) cached={stats['cached']} "
                    f"new={stats['downloaded']} failed={stats['failed']}")
    log(f"thumbnails ready: {len(paths)}")
    return paths


# --------------------------------------------------------------------------
# 3. face detection + embedding
# --------------------------------------------------------------------------
def build_face_app(device):
    from insightface.app import FaceAnalysis
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"]
    app = FaceAnalysis(name="buffalo_l", root=str(CACHE / "models"), providers=providers)
    app.prepare(ctx_id=0 if device == "cuda" else -1, det_size=(640, 640))
    return app


def face_pass(paths, device):
    import numpy as np

    app = build_face_app(device)
    log("detecting faces ...")
    out = {}
    t0 = time.time()
    for i, (key, path) in enumerate(paths.items(), 1):
        try:
            import cv2
            img = cv2.imread(str(path))
            if img is None:
                continue
            faces = app.get(img)
            if not faces:
                continue
            best = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
            emb = best.normed_embedding.astype(np.float32)
            bbox = [int(v) for v in best.bbox]
            out[key] = {"emb": emb, "bbox": bbox, "nfaces": len(faces)}
        except Exception:
            continue
        if i % 1000 == 0:
            log(f"  faces {i}/{len(paths)} ({i / max(1e-6, time.time() - t0):.1f}/s)")
    log(f"faces found in {len(out)} images")
    return out


def cluster_faces(face_data, threshold=0.52, min_size=2):
    import numpy as np

    keys = list(face_data.keys())
    if len(keys) < 2:
        return {}, 0
    embs = np.stack([face_data[k]["emb"] for k in keys])

    from sklearn.cluster import AgglomerativeClustering
    kwargs = dict(n_clusters=None, linkage="average", distance_threshold=threshold)
    try:
        model = AgglomerativeClustering(metric="cosine", **kwargs)
    except TypeError:
        model = AgglomerativeClustering(affinity="cosine", **kwargs)
    labels = model.fit_predict(embs)
    log(f"raw face clusters: {len(set(labels))}")

    groups = {}
    for k, lab in zip(keys, labels):
        groups.setdefault(int(lab), []).append(k)

    clusters = {}
    cluster_meta = []
    next_id = 0
    for members in groups.values():
        if len(members) < min_size:
            continue
        mat = np.stack([face_data[m]["emb"] for m in members])
        centroid = mat.mean(axis=0)
        centroid /= np.linalg.norm(centroid) + 1e-9
        sims = mat @ centroid
        cover = members[int(np.argmax(sims))]
        cid = next_id
        next_id += 1
        for m in members:
            clusters[m] = cid
        cluster_meta.append({"id": cid, "n": len(members), "cover": cover})

    cluster_meta.sort(key=lambda c: -c["n"])
    log(f"kept clusters: {len(cluster_meta)} covering {len(clusters)} images")
    return clusters, cluster_meta


# --------------------------------------------------------------------------
# 4. CLIP zero-shot tagging + dominant colour
# --------------------------------------------------------------------------
def build_clip(device):
    import torch
    from transformers import CLIPModel, CLIPProcessor

    name = "openai/clip-vit-base-patch32"
    model = CLIPModel.from_pretrained(name).to(device).eval()
    proc = CLIPProcessor.from_pretrained(name)
    return model, proc, torch


def tag_and_colour_pass(paths, device, top_k=3, batch_size=64):
    import numpy as np
    import torch
    from PIL import Image

    model, proc, torch_mod = build_clip(device)
    prompts = [f"a photo that is {t}" for t in TAGS]
    with torch.no_grad():
        inputs = proc(text=prompts, return_tensors="pt", padding=True).to(device)
        text_feats = model.get_text_features(**inputs)
        text_feats = text_feats / text_feats.norm(dim=-1, keepdim=True)

    tag_map, colour_map = {}, {}
    keys = list(paths.keys())
    t0 = time.time()

    for start in range(0, len(keys), batch_size):
        chunk = keys[start:start + batch_size]
        imgs, keep = [], []
        for k in chunk:
            try:
                im = Image.open(paths[k]).convert("RGB")
                imgs.append(im)
                keep.append(k)
            except Exception:
                continue

        for k in keep:
            try:
                small = Image.open(paths[k]).convert("RGB").resize((8, 8))
                arr = np.asarray(small, dtype=np.float32).reshape(-1, 3).mean(axis=0)
                best_i, best_d = 0, 1e9
                for i, (_name, rgb) in enumerate(COLOR_PALETTE):
                    d = sum((float(arr[c]) - rgb[c]) ** 2 for c in range(3)) ** 0.5
                    if d < best_d:
                        best_i, best_d = i, d
                colour_map[k] = best_i if best_d < COLOR_DIST_THRESHOLD else -1
            except Exception:
                colour_map[k] = -1

        if imgs:
            with torch.no_grad():
                inputs = proc(images=imgs, return_tensors="pt").to(device)
                feats = model.get_image_features(**inputs)
                feats = feats / feats.norm(dim=-1, keepdim=True)
                sims = (feats @ text_feats.T).cpu().numpy()
            for row, k in enumerate(keep):
                idxs = sims[row].argsort()[::-1][:top_k]
                tag_map[k] = [int(i) for i in idxs]

        if (start // batch_size) % 25 == 0:
            log(f"  clip {start + len(chunk)}/{len(keys)} "
                f"({(start + len(chunk)) / max(1e-6, time.time() - t0):.1f}/s)")

    return tag_map, colour_map


# --------------------------------------------------------------------------
# 5. write index
# --------------------------------------------------------------------------
def load_state():
    if STATE.exists():
        try:
            return json.loads(STATE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state), encoding="utf-8")
    tmp.rename(STATE)


def write_index(items, face_clusters, cluster_meta, tags, colours, state):
    OUT.mkdir(parents=True, exist_ok=True)

    items_path = OUT / "ai-items.jsonl"
    n_faces = 0
    with gzip.open(items_path, "wt", encoding="utf-8", compresslevel=9) as fh:
        for o in items:
            key = o["key"]
            rec = {
                "k": key,
                "s": o.get("size", 0),
                "u": o.get("uploaded", ""),
                "g": 1 if o.get("isImage") else 0,
            }
            cid = face_clusters.get(key)
            if cid is not None:
                rec["f"] = [int(cid)]
                b = state.get(key, {}).get("bbox")
                if b:
                    rec["b"] = b
                n_faces += 1
            if key in tags:
                rec["t"] = tags[key]
            if key in colours and colours[key] >= 0:
                rec["c"] = int(colours[key])
            fh.write(json.dumps(rec, separators=(",", ":")) + "\n")

    manifest = {
        "v": 1,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(items),
        "faces": n_faces,
        "tags": TAGS,
        "colors": [c[0] for c in COLOR_PALETTE],
        "clusters": cluster_meta,
    }
    (OUT / "ai.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")

    gz_size = (OUT / "ai-items.jsonl.gz")
    with open(items_path, "rb") as fin, gzip.open(gz_size, "wb", compresslevel=9) as fout:
        fout.writelines(fin)

    log(f"wrote {items_path.name} ({items_path.stat().st_size / 1e6:.1f} MB) "
        f"and {gz_size.name} ({gz_size.stat().st_size / 1e6:.1f} MB)")
    log(f"wrote ai.json (count={len(items)} clusters={len(cluster_meta)})")
    return manifest


def upload(bucket):
    objects = [
        ("index/ai.json", OUT / "ai.json"),
        ("index/ai-items.jsonl", OUT / "ai-items.jsonl"),
    ]
    for key, path in objects:
        log(f"uploading {key} ({path.stat().st_size / 1e6:.1f} MB) ...")
        r = subprocess.run(
            ["npx", "wrangler", "r2", "object", "put", bucket, key, "--file", str(path)],
            cwd=str(ROOT),
        )
        if r.returncode != 0:
            log(f"FAILED uploading {key}")
            return False
    log("upload complete")
    return True


def main():
    ap = argparse.ArgumentParser(description="Build the R2 Browser AI index from thumbnails")
    ap.add_argument("--endpoint", default="https://r2-browser.geminikil00.workers.dev")
    ap.add_argument("--folders", nargs="*", default=None, help="limit to these prefixes e.g. 4/ 5/")
    ap.add_argument("--limit", type=int, default=0, help="only index the first N objects (testing)")
    ap.add_argument("--workers", type=int, default=16, help="thumbnail download threads")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--upload", action="store_true", help="push index to R2 when done")
    ap.add_argument("--skip-existing", action="store_true",
                    help="reuse cached face/tag/colour results for unchanged keys")
    args = ap.parse_args()

    device = args.device
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"
    log(f"device: {device}")

    items = enumerate_keys(args.endpoint, args.limit, args.folders)
    if not items:
        log("nothing to index")
        return 1

    paths = download_thumbs(args.endpoint, items, args.workers)
    if not paths:
        log("no thumbnails available - is thumb/ populated in the bucket?")
        return 1

    state = load_state() if args.skip_existing else {}
    sig_of = {o["key"]: f"{o['key']}:{o.get('size')}" for o in items}
    todo = [k for k in paths if state.get(k, {}).get("sig") != sig_of[k]]
    log(f"to process: {len(todo)} (reusing {len(paths) - len(todo)})")

    face_data = {}
    if todo:
        face_data = face_pass({k: paths[k] for k in todo}, device)
    face_clusters = {}
    cluster_meta = []
    if face_data:
        face_clusters, cluster_meta = cluster_faces(face_data)

    # merge with cached results for keys we skipped
    if args.skip_existing:
        for k in paths:
            if k in todo:
                continue
            cid = state.get(k, {}).get("cluster")
            if cid is not None:
                face_clusters[k] = int(cid)

    tag_map, colour_map = {}, {}
    if todo:
        tag_map, colour_map = tag_and_colour_pass({k: paths[k] for k in todo}, device)

    if args.skip_existing:
        for k in paths:
            if k in todo:
                continue
            st = state.get(k, {})
            if st.get("tags"):
                tag_map[k] = st["tags"]
            if st.get("colour") is not None:
                colour_map[k] = st["colour"]

    for k in paths:
        entry = {"sig": sig_of[k]}
        if k in face_clusters:
            entry["cluster"] = face_clusters[k]
            if k in face_data:
                entry["bbox"] = face_data[k]["bbox"]
        if k in tag_map:
            entry["tags"] = tag_map[k]
        if k in colour_map:
            entry["colour"] = int(colour_map[k])
        state[k] = entry
    save_state(state)

    write_index(items, face_clusters, cluster_meta, tag_map, colour_map, state)

    if args.upload:
        upload(read_bucket_name())
    return 0


if __name__ == "__main__":
    sys.exit(main())