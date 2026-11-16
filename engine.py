#!/usr/bin/env python3
"""
Zip-Recovery engine: candidate generation + password testing.

Purpose: help you recover the password to an archive *you own* by
generating variations of words you might have used and testing each
one against the archive. Built for recall, not mass cracking.

Supports .7z and .zip. Backends, auto-detected per file:
  .7z   -> py7zr (pip install py7zr)  or  the 7z CLI (7z/7za/7zz)
  .zip  -> the 7z CLI  or  Python's stdlib zipfile (ZipCrypto only;
           AES-encrypted zips need the 7z CLI or py7zr)

Nothing third-party is required to import this module; py7zr is optional.
"""

import itertools
import os
import shutil
import subprocess
import sys
import time
import zipfile

# --------------------------------------------------------------------------- #
# Rule kits
# --------------------------------------------------------------------------- #

LEET_MAP = {
    "a": ["@", "4"], "e": ["3"], "i": ["1", "!"], "o": ["0"],
    "s": ["$", "5"], "t": ["7"], "l": ["1"], "g": ["9"], "b": ["8"],
}

COMMON_SUFFIXES = ["", "!", "1", "123", "?", "#", "$", "12", "2", "01",
                   "1234", "!!", "00", "007", "69", "99", "11", "22"]
COMMON_PREFIXES = ["!", "1", "@"]


def k_case(word):
    seen = set()
    for v in (word, word.lower(), word.upper(), word.capitalize(),
              word.swapcase(), word.title()):
        if v not in seen:
            seen.add(v)
            yield v


def k_affix(word, digits, years):
    for suf in COMMON_SUFFIXES:
        yield word + suf
    for d in digits:
        yield word + d
    for y in years:
        yield word + y
        yield word + "!" + y
        yield word + "@" + y
    for pre in COMMON_PREFIXES:
        yield pre + word


def _leet_variants(word, max_variants):
    options = []
    for ch in word:
        low = ch.lower()
        options.append([ch] + LEET_MAP[low] if low in LEET_MAP else [ch])
    count = 0
    for combo in itertools.product(*options):
        yield "".join(combo)
        count += 1
        if count >= max_variants:
            return


def k_dup(word):
    yield word + word
    yield word[::-1]
    yield word + word[::-1]


# --------------------------------------------------------------------------- #
# Words + candidate stream
# --------------------------------------------------------------------------- #

def load_words(paths, hints):
    """Hints first (most likely), then wordlist files, de-duplicated."""
    words, seen = [], set()

    def add(w):
        w = w.rstrip("\r\n")
        if w and w not in seen:
            seen.add(w)
            words.append(w)

    for h in hints:
        add(h)
    for p in paths:
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    add(line)
        except OSError as e:
            print(f"[!] could not read wordlist {p}: {e}", file=sys.stderr)
    return words


def generate(words, kits, digits, years, leet_cap, combo, combo_seps):
    """Yield unique candidates, most-likely-first, de-duplicated."""
    seen = set()

    def emit(c):
        if c and c not in seen:
            seen.add(c)
            return True
        return False

    for w in words:
        if "base" in kits and emit(w):
            yield w
        if "case" in kits:
            for v in k_case(w):
                if emit(v):
                    yield v

    if "affix" in kits:
        for w in words:
            for v in k_affix(w, digits, years):
                if emit(v):
                    yield v

    if "leet" in kits:
        for w in words:
            for v in _leet_variants(w, leet_cap):
                if emit(v):
                    yield v

    if "dup" in kits:
        for w in words:
            for v in k_dup(w):
                if emit(v):
                    yield v

    if "combo" in kits and combo:
        for a, b in itertools.permutations(words, 2):
            for sep in combo_seps:
                if emit(a + sep + b):
                    yield a + sep + b


def parse_range(spec):
    """'1980-2026' or '0-99,abc' -> list of strings."""
    out = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part and all(s.strip().lstrip("-").isdigit()
                               for s in part.split("-", 1)):
            a, b = (int(x) for x in part.split("-", 1))
            step = 1 if b >= a else -1
            out.extend(str(n) for n in range(a, b + step, step))
        else:
            out.append(part)
    return out


# --------------------------------------------------------------------------- #
# Backends
# --------------------------------------------------------------------------- #

def detect_cli():
    for exe in ("7z", "7za", "7zz", "7zr", "7z.exe", "7za.exe"):
        path = shutil.which(exe)
        if path:
            return path
    return None


class Py7zrBackend:
    name = "py7zr"

    def __init__(self, archive):
        import py7zr
        self._py7zr = py7zr
        self.archive = archive

    def try_password(self, pw):
        # py7zr's test() returns True if every CRC validates, False on a CRC
        # mismatch (i.e. wrong password), and None when the archive carries no
        # CRC to check. A wrong password usually returns False or raises; it
        # must NOT be treated as success, so we check the result explicitly.
        try:
            with self._py7zr.SevenZipFile(self.archive, mode="r", password=pw) as z:
                result = z.test()
            if result is True:
                return True
            if result is False:
                return False
            # result is None: no CRC present, so verify by fully reading the
            # data with this password (a wrong one raises a decompression error)
            with self._py7zr.SevenZipFile(self.archive, mode="r", password=pw) as z:
                z.readall()
            return True
        except Exception:
            return False


class CliBackend:
    """Universal: the 7z binary handles both .7z and .zip (incl. AES)."""
    name = "7z CLI"

    def __init__(self, archive, exe):
        self.archive = archive
        self.exe = exe

    def try_password(self, pw):
        try:
            proc = subprocess.run(
                [self.exe, "t", f"-p{pw}", "-y", "-bso0", "-bse0", self.archive],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120,
            )
        except (subprocess.TimeoutExpired, OSError):
            return False
        out = proc.stdout.decode("utf-8", "replace") if proc.stdout else ""
        return proc.returncode == 0 and "Wrong password" not in out


class ZipfileBackend:
    """Stdlib fallback for .zip. Handles ZipCrypto, not AES."""
    name = "stdlib zipfile"

    def __init__(self, archive):
        self.archive = archive
        with zipfile.ZipFile(archive) as zf:
            self._first = next((n for n in zf.namelist()
                                if not n.endswith("/")), None)

    def try_password(self, pw):
        if self._first is None:
            return False
        try:
            with zipfile.ZipFile(self.archive) as zf:
                zf.setpassword(pw.encode("utf-8", "replace"))
                with zf.open(self._first) as f:
                    f.read(1)
            return True
        except Exception:
            return False


class BackendError(Exception):
    pass


def pick_backend(archive, forced=None):
    """Choose a password-testing backend for this archive."""
    ext = os.path.splitext(archive)[1].lower()
    cli = detect_cli()

    if forced == "cli":
        if not cli:
            raise BackendError("7z CLI requested but not found on PATH.")
        return CliBackend(archive, cli)
    if forced == "py7zr":
        return Py7zrBackend(archive)
    if forced == "zipfile":
        return ZipfileBackend(archive)

    if ext == ".7z":
        try:
            return Py7zrBackend(archive)
        except Exception:
            if cli:
                return CliBackend(archive, cli)
            raise BackendError(
                "No backend for .7z. Install py7zr (pip install py7zr) "
                "or put the 7z binary on PATH.")
    # .zip and anything else: prefer the versatile CLI, else stdlib zip
    if cli:
        return CliBackend(archive, cli)
    if ext == ".zip":
        return ZipfileBackend(archive)
    raise BackendError(
        f"No backend for '{ext}'. Install the 7z binary (handles .7z and .zip).")


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #

def recover(archive, words, *, kits=("base", "case", "affix", "leet"),
            digits="0-99", years="2015-2026", leet_cap=64,
            combo=False, combo_seps=("-", "_", ""),
            forced_backend=None, max_candidates=0, max_seconds=0,
            progress_cb=None, should_stop=None, progress_every=200):
    """
    Try to recover the archive password.

    progress_cb(tried, last_candidate, rate) is called periodically.
    should_stop() -> bool lets a caller cancel (e.g. a web "stop" button).
    Returns a dict: {found, password, tried, seconds, backend}.
    """
    kits = set(kits)
    digs = parse_range(digits)
    yrs = parse_range(years)
    backend = pick_backend(archive, forced_backend)

    stream = generate(words, kits, digs, yrs, leet_cap, combo, tuple(combo_seps))
    start = time.time()
    tried = 0
    result = {"found": False, "password": None, "tried": 0,
              "seconds": 0.0, "backend": backend.name}

    for pw in stream:
        if should_stop and should_stop():
            break
        if backend.try_password(pw):
            result.update(found=True, password=pw, tried=tried + 1,
                          seconds=time.time() - start)
            if progress_cb:
                progress_cb(tried + 1, pw, _rate(tried + 1, start))
            return result
        tried += 1
        if progress_cb and tried % progress_every == 0:
            progress_cb(tried, pw, _rate(tried, start))
        if max_candidates and tried >= max_candidates:
            break
        if max_seconds and (time.time() - start) >= max_seconds:
            break

    result.update(tried=tried, seconds=time.time() - start)
    if progress_cb:
        progress_cb(tried, None, _rate(tried, start))
    return result


def _rate(n, start):
    return n / max(time.time() - start, 1e-6)
