#!/usr/bin/env python3
"""
Zip-Recovery web UI.

A self-hosted page for recovering the password to a .7z/.zip archive you
own. Upload one archive, upload a wordlist and/or type in some hints, tune
the attempt settings, and it tests candidates in the background while the
page shows progress.

Design:
  * one archive at a time
  * upload your own wordlist, and/or type hint words
  * attempt budget is fully configurable per job (0 = unlimited, the default)
  * optional shared-secret access token (ZR_TOKEN) for server deployments
  * uploaded archives and wordlists are deleted as soon as a job finishes

Config via environment variables (all optional):
  ZR_HOST        interface to bind              (default 127.0.0.1)
  ZR_PORT        port                            (default 8000)
  ZR_TOKEN       require this access token       (default: none)
  ZR_MAX_MB      max upload size in MB            (default 1024)
  ZR_MAX_ATTEMPTS default attempt cap, 0=none    (default 0, unlimited)
  ZR_MAX_SECONDS default time cap, 0=none        (default 0, unlimited)
  ZR_MAX_JOBS    concurrent jobs                 (default 2)
  ZR_WORK_DIR    scratch dir for uploads         (default: a temp dir)
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

from flask import Flask, jsonify, render_template, request, abort
from werkzeug.utils import secure_filename

import engine

# When run from source, data files (templates/, static/, wordlists.json) sit
# next to this file. When frozen into a PyInstaller executable (--onefile),
# they're unpacked into a temp dir at sys._MEIPASS instead.
if getattr(sys, "frozen", False):
    HERE = sys._MEIPASS
else:
    HERE = os.path.dirname(os.path.abspath(__file__))

try:
    with open(os.path.join(HERE, "wordlists.json"), encoding="utf-8") as _f:
        CATALOG = json.load(_f)
except (OSError, ValueError):
    CATALOG = {"note": "", "default_rate": 50, "lists": []}
CATALOG_BY_ID = {e["id"]: e for e in CATALOG.get("lists", [])}

# --------------------------------------------------------------------------- #

HOST = os.environ.get("ZR_HOST", "127.0.0.1")
PORT = int(os.environ.get("ZR_PORT", "8000"))
TOKEN = os.environ.get("ZR_TOKEN", "").strip()
MAX_MB = int(os.environ.get("ZR_MAX_MB", "1024"))
DEF_MAX_ATTEMPTS = int(os.environ.get("ZR_MAX_ATTEMPTS", "0"))   # 0 = unlimited
DEF_MAX_SECONDS = int(os.environ.get("ZR_MAX_SECONDS", "0"))     # 0 = unlimited
MAX_JOBS = int(os.environ.get("ZR_MAX_JOBS", "2"))
WORK_DIR = os.environ.get("ZR_WORK_DIR") or tempfile.mkdtemp(prefix="ziprec-")
CACHE_DIR = os.path.join(WORK_DIR, "wordlist-cache")
FETCH_MAX_MB = int(os.environ.get("ZR_FETCH_MAX_MB", "200"))  # cap catalog downloads

ALLOWED_EXT = {".7z", ".zip"}

app = Flask(__name__,
           template_folder=os.path.join(HERE, "templates"),
           static_folder=os.path.join(HERE, "static"))
app.config["MAX_CONTENT_LENGTH"] = MAX_MB * 1024 * 1024

JOBS = {}
JOBS_LOCK = threading.Lock()


# --------------------------------------------------------------------------- #

def check_token():
    if not TOKEN:
        return
    supplied = (request.headers.get("X-Access-Token")
                or request.form.get("token")
                or request.args.get("token", ""))
    if supplied != TOKEN:
        abort(401, description="missing or wrong access token")


def active_job_count():
    with JOBS_LOCK:
        return sum(1 for j in JOBS.values() if j["state"] == "running")


def _int(form_value, default):
    try:
        v = int(str(form_value).strip())
        return v if v >= 0 else default
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# Worker
# --------------------------------------------------------------------------- #

def run_job(job_id, archive_path, wordlist_path, words, opts):
    job = JOBS[job_id]

    def progress(tried, last, rate):
        job["tried"] = tried
        job["rate"] = round(rate, 1)
        job["last"] = (last or "")[:40]

    def should_stop():
        return job.get("cancel", False)

    try:
        res = engine.recover(
            archive_path, words,
            kits=opts["kits"], digits=opts["digits"], years=opts["years"],
            leet_cap=opts["leet_cap"], combo=opts["combo"],
            combo_seps=opts["combo_seps"],
            max_candidates=opts["max_attempts"], max_seconds=opts["max_seconds"],
            progress_cb=progress, should_stop=should_stop,
        )
        job["backend"] = res["backend"]
        job["tried"] = res["tried"]
        job["seconds"] = round(res["seconds"], 1)
        if res["found"]:
            job["state"] = "found"
            job["password"] = res["password"]
        elif job.get("cancel"):
            job["state"] = "cancelled"
        else:
            job["state"] = "exhausted"
    except engine.BackendError as e:
        job["state"] = "error"
        job["error"] = str(e)
    except Exception as e:
        job["state"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"
    finally:
        # remove this job's own uploads; the shared wordlist cache is elsewhere
        shutil.rmtree(os.path.dirname(archive_path), ignore_errors=True)


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #

def _download(url, dest):
    """Download url to dest, capped at FETCH_MAX_MB."""
    limit = FETCH_MAX_MB * 1024 * 1024
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "Zip-Recovery"})
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as out:
        read = 0
        while True:
            chunk = r.read(65536)
            if not chunk:
                break
            read += len(chunk)
            if read > limit:
                out.close()
                os.remove(tmp)
                raise ValueError(f"download exceeds the {FETCH_MAX_MB} MB cap; "
                                 f"raise ZR_FETCH_MAX_MB or fetch it yourself")
            out.write(chunk)
    os.replace(tmp, dest)
    return dest


def fetch_and_extract(entry):
    """Self-hosted only: download a big list (e.g. rockyou) and extract the
    plain-text wordlist, caching the result. Handles .tar.gz / .gz / plain."""
    import gzip
    import tarfile
    os.makedirs(CACHE_DIR, exist_ok=True)
    dest = os.path.join(CACHE_DIR, entry["id"] + ".txt")
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    url = entry["download_url"]
    raw = os.path.join(CACHE_DIR, entry["id"] + "_dl")
    _download(url, raw)
    low = url.lower()
    try:
        if low.endswith((".tar.gz", ".tgz")):
            with tarfile.open(raw, "r:gz") as tf:
                members = [m for m in tf.getmembers() if m.isfile()]
                member = next((m for m in members if m.name.endswith(".txt")), None) \
                    or (members[0] if members else None)
                if not member:
                    raise ValueError("archive contained no file to extract")
                with tf.extractfile(member) as src, open(dest, "wb") as out:
                    shutil.copyfileobj(src, out)  # one member's bytes, no path traversal
        elif low.endswith(".gz"):
            with gzip.open(raw, "rb") as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)
        else:
            os.replace(raw, dest)
            return dest
    finally:
        if os.path.exists(raw):
            os.remove(raw)
    return dest


def fetch_wordlist(entry):
    """Return a path to the catalog wordlist. Reads bundled lists locally,
    downloads+extracts server-only big lists (server_fetch), and downloads
    plain remote lists otherwise."""
    url = entry.get("url")
    # bundled list shipped with the repo (and with the frozen exe)
    if entry.get("fetchable") and url and not url.lower().startswith(("http://", "https://")):
        local = os.path.join(HERE, "docs", *url.split("/"))
        if os.path.isfile(local):
            return local
        raise ValueError(f"bundled wordlist not found ({url})")
    # big list this self-hosted server can download and run (e.g. rockyou)
    if entry.get("server_fetch") and entry.get("download_url"):
        return fetch_and_extract(entry)
    # plain remote list
    if entry.get("fetchable") and url and url.lower().startswith(("http://", "https://")):
        os.makedirs(CACHE_DIR, exist_ok=True)
        dest = os.path.join(CACHE_DIR, entry["id"] + ".txt")
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            return dest
        return _download(url, dest)
    raise ValueError("this list is not available here; use the shown commands, "
                     "or the hashcat path")


@app.route("/")
def index():
    return render_template("index.html", token_required=bool(TOKEN),
                           max_mb=MAX_MB, def_max_attempts=DEF_MAX_ATTEMPTS,
                           def_max_seconds=DEF_MAX_SECONDS)


@app.route("/wordlists")
def wordlists():
    return jsonify(CATALOG)


@app.route("/health")
def health():
    return jsonify(ok=True)


@app.route("/start", methods=["POST"])
def start():
    check_token()

    if active_job_count() >= MAX_JOBS:
        abort(429, description="a job is already running; this tool works one "
                               "archive at a time")

    upload = request.files.get("archive")
    if not upload or not upload.filename:
        abort(400, description="no archive uploaded")
    ext = os.path.splitext(upload.filename)[1].lower()
    if ext not in ALLOWED_EXT:
        abort(400, description="only .7z and .zip are supported")

    job_id = uuid.uuid4().hex
    job_dir = os.path.join(WORK_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    archive_path = os.path.join(job_dir,
                                secure_filename(upload.filename) or "archive" + ext)
    upload.save(archive_path)

    hints = [ln.strip() for ln in request.form.get("hints", "").splitlines()
             if ln.strip()]
    wl = request.files.get("wordlist")
    wordlist_id = request.form.get("wordlist_id", "").strip()
    wordlist_path = None
    if wl and wl.filename:                       # an uploaded file always wins
        wordlist_path = os.path.join(job_dir, "wordlist.txt")
        wl.save(wordlist_path)
    elif wordlist_id and wordlist_id != "none":  # otherwise a catalog pick
        entry = CATALOG_BY_ID.get(wordlist_id)
        if not entry:
            shutil.rmtree(job_dir, ignore_errors=True)
            abort(400, description="unknown wordlist selection")
        try:
            wordlist_path = fetch_wordlist(entry)
        except Exception as e:
            shutil.rmtree(job_dir, ignore_errors=True)
            abort(400, description=f"could not fetch '{entry.get('name')}': {e}")
    words = engine.load_words([wordlist_path] if wordlist_path else [], hints)
    if not words:
        shutil.rmtree(job_dir, ignore_errors=True)
        abort(400, description="choose a wordlist, upload one, or add hint words")

    kits = request.form.getlist("kits") or ["base", "case", "affix", "leet"]
    opts = {
        "kits": set(kits),
        "digits": request.form.get("digits", "0-99"),
        "years": request.form.get("years", "2015-2026"),
        "leet_cap": _int(request.form.get("leet_cap"), 64),
        "combo": "combo" in kits,
        "combo_seps": tuple((request.form.get("combo_sep", "-,_,") or "").split(",")),
        # attempt budget: form overrides the server default; 0 = unlimited
        "max_attempts": _int(request.form.get("max_attempts"), DEF_MAX_ATTEMPTS),
        "max_seconds": _int(request.form.get("max_seconds"), DEF_MAX_SECONDS),
    }

    with JOBS_LOCK:
        JOBS[job_id] = {"state": "running", "tried": 0, "rate": 0.0,
                        "last": "", "password": None, "created": time.time(),
                        "filename": os.path.basename(upload.filename),
                        "wordlist": bool(wordlist_path),
                        "unlimited": opts["max_attempts"] == 0 and opts["max_seconds"] == 0}

    threading.Thread(target=run_job,
                     args=(job_id, archive_path, wordlist_path, words, opts),
                     daemon=True).start()
    return jsonify(job_id=job_id)


@app.route("/status/<job_id>")
def status(job_id):
    check_token()
    job = JOBS.get(job_id)
    if not job:
        abort(404, description="unknown job")
    out = {k: v for k, v in job.items() if k != "cancel"}
    out["job_id"] = job_id
    return jsonify(out)


@app.route("/cancel/<job_id>", methods=["POST"])
def cancel(job_id):
    check_token()
    job = JOBS.get(job_id)
    if not job:
        abort(404, description="unknown job")
    job["cancel"] = True
    return jsonify(ok=True)


@app.errorhandler(401)
@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(413)
@app.errorhandler(429)
def _err(e):
    return jsonify(error=getattr(e, "description", str(e))), e.code


# --------------------------------------------------------------------------- #

def _startup_banner():
    public = HOST not in ("127.0.0.1", "localhost", "::1")
    budget = "unlimited" if DEF_MAX_ATTEMPTS == 0 and DEF_MAX_SECONDS == 0 \
        else f"{DEF_MAX_ATTEMPTS or 'unlimited'} attempts / {DEF_MAX_SECONDS or 'unlimited'}s"
    print(f"  Zip-Recovery  ->  http://{HOST}:{PORT}")
    print(f"  work dir: {WORK_DIR}")
    print(f"  default attempt budget: {budget} (configurable per job)")
    print(f"  7z CLI detected: {bool(engine.detect_cli())}")
    if public and not TOKEN:
        print("\n  !! NOTE: bound to a public interface with NO access token.")
        print("  !! Anyone who can reach this port can use it. Set ZR_TOKEN or")
        print("  !! keep it behind something that authenticates, if that matters to you.\n")


if __name__ == "__main__":
    _startup_banner()
    if getattr(sys, "frozen", False):
        # double-clicked exe, no terminal to read the URL from: open it for them
        import webbrowser
        threading.Timer(1.0, lambda: webbrowser.open(f"http://{HOST}:{PORT}")).start()
    app.run(host=HOST, port=PORT, threaded=True)
