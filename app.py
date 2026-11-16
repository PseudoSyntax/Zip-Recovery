#!/usr/bin/env python3
"""
Zip-Recovery web UI.

A self-hosted page for recovering the password to a .7z/.zip archive you
own. You upload the archive, give it words you might have used, and it
tests variations in the background while the page shows progress.

Intended use: your own archives. It is NOT a public cracking service.
Safeguards baked in:
  * binds to 127.0.0.1 by default (localhost only)
  * optional shared-secret access token (ZR_TOKEN) for server deployments
  * loud warning if you bind to a public interface with no token
  * uploaded archives are deleted as soon as a job finishes

Config via environment variables:
  ZR_HOST        interface to bind         (default 127.0.0.1)
  ZR_PORT        port                       (default 8000)
  ZR_TOKEN       require this access token  (default: none)
  ZR_MAX_MB      max upload size in MB       (default 200)
  ZR_MAX_CANDIDATES  per-job candidate cap  (default 2000000)
  ZR_MAX_SECONDS per-job time cap in seconds(default 1800)
  ZR_MAX_JOBS    concurrent jobs            (default 2)
  ZR_WORK_DIR    scratch dir for uploads    (default: a temp dir)
"""

import os
import shutil
import tempfile
import threading
import time
import uuid

from flask import (Flask, jsonify, render_template, request, abort,
                   send_from_directory)
from werkzeug.utils import secure_filename

import engine

# --------------------------------------------------------------------------- #

HOST = os.environ.get("ZR_HOST", "127.0.0.1")
PORT = int(os.environ.get("ZR_PORT", "8000"))
TOKEN = os.environ.get("ZR_TOKEN", "").strip()
MAX_MB = int(os.environ.get("ZR_MAX_MB", "200"))
MAX_CANDIDATES = int(os.environ.get("ZR_MAX_CANDIDATES", "2000000"))
MAX_SECONDS = int(os.environ.get("ZR_MAX_SECONDS", "1800"))
MAX_JOBS = int(os.environ.get("ZR_MAX_JOBS", "2"))
WORK_DIR = os.environ.get("ZR_WORK_DIR") or tempfile.mkdtemp(prefix="ziprec-")

ALLOWED_EXT = {".7z", ".zip"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_MB * 1024 * 1024

JOBS = {}
JOBS_LOCK = threading.Lock()


# --------------------------------------------------------------------------- #
# Auth: if a token is configured, every state-changing/reading route needs it.
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
            max_candidates=MAX_CANDIDATES, max_seconds=MAX_SECONDS,
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
    except Exception as e:  # keep the server alive on any engine hiccup
        job["state"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"
    finally:
        # never retain the user's archive or wordlist
        for path in (archive_path, wordlist_path):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #

@app.route("/")
def index():
    return render_template("index.html", token_required=bool(TOKEN),
                           max_mb=MAX_MB)


@app.route("/health")
def health():
    return jsonify(ok=True)


@app.route("/start", methods=["POST"])
def start():
    check_token()

    if active_job_count() >= MAX_JOBS:
        abort(429, description="too many jobs running, try again shortly")

    upload = request.files.get("archive")
    if not upload or not upload.filename:
        abort(400, description="no archive uploaded")
    ext = os.path.splitext(upload.filename)[1].lower()
    if ext not in ALLOWED_EXT:
        abort(400, description="only .7z and .zip are supported")

    job_id = uuid.uuid4().hex
    job_dir = os.path.join(WORK_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    archive_path = os.path.join(job_dir, secure_filename(upload.filename) or "a" + ext)
    upload.save(archive_path)

    # words: hints from the textarea + an optional uploaded wordlist
    hints = [ln.strip() for ln in request.form.get("hints", "").splitlines()
             if ln.strip()]
    wordlist_path = None
    wl = request.files.get("wordlist")
    if wl and wl.filename:
        wordlist_path = os.path.join(job_dir, "wordlist.txt")
        wl.save(wordlist_path)
    words = engine.load_words([wordlist_path] if wordlist_path else [], hints)
    if not words:
        shutil.rmtree(job_dir, ignore_errors=True)
        abort(400, description="give at least one hint word or a wordlist")

    kits = request.form.getlist("kits") or ["base", "case", "affix", "leet"]
    opts = {
        "kits": set(kits),
        "digits": request.form.get("digits", "0-99"),
        "years": request.form.get("years", "2015-2026"),
        "leet_cap": int(request.form.get("leet_cap", "64") or 64),
        "combo": "combo" in kits,
        "combo_seps": tuple((request.form.get("combo_sep", "-,_,") or "").split(",")),
    }

    with JOBS_LOCK:
        JOBS[job_id] = {"state": "running", "tried": 0, "rate": 0.0,
                        "last": "", "password": None, "created": time.time(),
                        "filename": os.path.basename(upload.filename)}

    t = threading.Thread(target=run_job,
                         args=(job_id, archive_path, wordlist_path, words, opts),
                         daemon=True)
    t.start()
    return jsonify(job_id=job_id)


@app.route("/status/<job_id>")
def status(job_id):
    check_token()
    job = JOBS.get(job_id)
    if not job:
        abort(404, description="unknown job")
    out = {k: v for k, v in job.items() if k not in ("cancel",)}
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
    print(f"  Zip-Recovery  ->  http://{HOST}:{PORT}")
    print(f"  work dir: {WORK_DIR}")
    print(f"  backend for .7z needs py7zr or the 7z CLI; "
          f"7z CLI detected: {bool(engine.detect_cli())}")
    if public and not TOKEN:
        print("\n  !! WARNING: bound to a public interface with NO access token.")
        print("  !! Anyone who can reach this port can use it. Set ZR_TOKEN,")
        print("  !! put it behind a reverse proxy with auth, or bind 127.0.0.1.\n")
    elif public:
        print("  bound to a public interface; access token is required.")


if __name__ == "__main__":
    _startup_banner()
    # threaded so status polling works while a job runs
    app.run(host=HOST, port=PORT, threaded=True)
