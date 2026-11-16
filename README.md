# Zip-Recovery

A password recovery tool for `.7z` and `.zip` archives. You give it a wordlist
and/or the words you think you might have used, and it generates variations
(case changes, leetspeak, appended years/numbers/symbols, two-word combos) and
tests each one against the archive until it finds the password.

It comes in three forms:

1. **`recall.py`** — a command-line tool.
2. **`app.py`** — a self-hosted web app (upload an archive and wordlist, watch
   progress, get the password). Runs on your own machine or server.
3. **`docs/`** — a **fully client-side** version for GitHub Pages. Everything
   runs in the browser; the archive and wordlist never leave your machine.

It works one archive at a time. The attempt budget is fully configurable and
defaults to unlimited, so a run continues until it finds the password or
exhausts every candidate.

> Use it on archives you own or are authorised to open.

## How it works

The engine builds a candidate stream, most-likely-first, from your words:

| kit     | what it does                                  | example         |
|---------|-----------------------------------------------|-----------------|
| `base`  | the word as-is                                | `summer`        |
| `case`  | lower / UPPER / Capitalised / sWAPPED / Title | `Summer`        |
| `affix` | append years, digit runs, and symbols         | `summer2019!`   |
| `leet`  | leetspeak substitutions (bounded per word)    | `summ3r`        |
| `dup`   | doubling and reversal                         | `remmus`        |
| `combo` | join two words from your pool (opt-in)        | `summer-fluffy` |

Each candidate is tested by actually trying to open the archive, so a hit is a
real hit. The Python engine (`engine.py`) and the JavaScript engine
(`docs/engine.js`) generate identical candidates in the same order.

Backends are auto-detected per file:

- **CLI / server:** `py7zr` or the `7z` binary for `.7z`; the `7z` binary or
  Python's standard-library `zipfile` for `.zip`.
- **Browser:** [zip.js](https://github.com/gildas-lormeau/zip.js) for `.zip`,
  and a WebAssembly build of 7-Zip for `.7z`.

## 1. Command line

```bash
python recall.py secret.7z -H Fluffy -H Summer -w mywords.txt --years 2010-2026
python recall.py secret.7z -H Fluffy --dry-run --max 50   # preview candidates
```

`-H/--hint` is repeatable and tried first. `-w/--wordlist` is repeatable. Run
`python recall.py --help` for every option.

## 2. Self-hosted web app

```bash
pip install -r requirements.txt
python app.py        # http://127.0.0.1:8000
```

Upload the archive, upload a wordlist and/or type hint words, adjust the attempt
settings, and start. Progress updates live. Uploaded archives and wordlists are
deleted as soon as the job finishes.

### Settings

Everything in the **Attempt settings** panel is per job: which kits run, the
year and digit ranges, the leet cap, combo separators, and the attempt budget
(**max attempts** and **max time**, both `0` for unlimited).

Server-wide defaults come from environment variables, all optional:

| variable          | default      | meaning                               |
|-------------------|--------------|---------------------------------------|
| `ZR_HOST`         | `127.0.0.1`  | interface to bind                     |
| `ZR_PORT`         | `8000`       | port                                  |
| `ZR_TOKEN`        | *(none)*     | require this access token             |
| `ZR_MAX_MB`       | `1024`       | max upload size                       |
| `ZR_MAX_ATTEMPTS` | `0`          | default attempt cap (`0` = unlimited) |
| `ZR_MAX_SECONDS`  | `0`          | default time cap (`0` = unlimited)    |
| `ZR_MAX_JOBS`     | `2`          | concurrent jobs                       |

The app binds to localhost by default. If you put it on a public server, set
`ZR_TOKEN` (or keep it behind something that authenticates) so it is not open to
everyone who can reach the port:

```bash
ZR_HOST=0.0.0.0 ZR_TOKEN="$(openssl rand -hex 16)" python app.py
```

### Docker

```bash
docker build -t zip-recovery .
docker run --rm -p 8000:8000 -e ZR_TOKEN="change-me" zip-recovery
```

The image installs `p7zip-full`, so `.7z` and AES `.zip` work out of the box.

## 3. GitHub Pages (client-side)

The `docs/` folder is a static site that does everything in the browser. There
is no server: your archive and wordlist are read with the File API and tested
locally, and nothing is uploaded. The page downloads only the decryption
library code from a CDN.

To publish it: in the repo, go to **Settings → Pages**, set **Source** to
*Deploy from a branch*, pick **`main`** and the **`/docs`** folder, and save.
Your copy will be live at `https://pseudosyntax.github.io/Zip-Recovery/`.

To run it locally instead:

```bash
cd docs && python -m http.server 8080   # http://localhost:8080
```

Notes:

- `.zip` (ZipCrypto and AES) is well supported in the browser.
- `.7z` uses a WebAssembly 7-Zip build. It works but is slower than the native
  tools, so for large `.7z` wordlists prefer `recall.py` or the self-hosted app.
- For a fully offline, no-CDN deployment, vendor the zip.js and 7z-wasm files
  into `docs/` and point the imports at the local copies.

## The fast path (true brute force)

The recovery here tests one password per archive-open, which is ideal for recall
but slow for blind cracking. When you need raw speed, extract the hash and run it
on a GPU:

```bash
7z2john secret.7z > hash.txt     # or: zip2john secret.zip > hash.txt
hashcat -m 11600 -a 0 hash.txt wordlist.txt -r rules/best64.rule   # 7z
hashcat -m 13600 -a 0 hash.txt wordlist.txt -r rules/best64.rule   # WinZip AES
```

## License

MIT. See `LICENSE`.
