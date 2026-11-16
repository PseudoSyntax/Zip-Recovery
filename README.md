# Zip-Recovery

A password *recall* tool for `.7z` and `.zip` archives **you own**. You give it
the words you think you might have used, and it generates variations (case
changes, leetspeak, appended years/numbers/symbols, two-word combos) and tests
each one against the archive until it finds the password.

It comes in two forms:

1. **`recall.py`** — a command-line tool.
2. **`app.py`** — a small self-hosted web page: upload an archive, type in some
   hints, watch progress, get the password.

It is built for *remembering* a password you set, not for large-scale cracking.
Seed it with the handful of words you actually tend to use and let it explore
around them. For a genuine brute force, use the `7z2john` + `hashcat -m 11600`
route noted at the bottom.

> **Intended use.** This is for archives you own or are authorised to open.
> The web app binds to `127.0.0.1` by default and supports an access token so
> that a server deployment is not an open cracking endpoint for the world. Keep
> it that way.

## How it works

The engine builds a candidate stream, most-likely-first, from your words:

| kit     | what it does                                             | example           |
|---------|----------------------------------------------------------|-------------------|
| `base`  | the word as-is                                           | `summer`          |
| `case`  | lower / UPPER / Capitalised / sWAPPED / Title            | `Summer`          |
| `affix` | append years, digit runs, and symbols                    | `summer2019!`     |
| `leet`  | leetspeak substitutions (bounded per word)               | `summ3r`          |
| `dup`   | doubling and reversal                                    | `remmus`          |
| `combo` | join two words from your pool (opt-in)                   | `summer-fluffy`   |

Each candidate is tested by actually trying to open the archive, so a hit is a
real hit. Backends are auto-detected per file:

- `.7z` → [`py7zr`](https://pypi.org/project/py7zr/) if installed, else the
  `7z` binary.
- `.zip` → the `7z` binary if present (handles AES zips too), else Python's
  standard-library `zipfile` (ZipCrypto only).

## Command line

```bash
# words you remember, plus a personal list, default kits:
python recall.py secret.7z -H Fluffy -H Summer -w mywords.txt --years 2010-2026

# preview what it would try, without testing:
python recall.py secret.7z -H Fluffy --dry-run --max 50
```

`-H/--hint` is repeatable and tried first. `-w/--wordlist` is repeatable.
Run `python recall.py --help` for every option.

## Web app

```bash
pip install -r requirements.txt
python app.py
# -> http://127.0.0.1:8000
```

Open the page, upload your archive, type the words you might have used, pick the
kits, and start. Progress updates live; the found password is shown on the page.
Uploaded archives are deleted as soon as the job ends.

### Running it on a server

The app reads its configuration from environment variables:

| variable          | default      | meaning                                  |
|-------------------|--------------|------------------------------------------|
| `ZR_HOST`         | `127.0.0.1`  | interface to bind                        |
| `ZR_PORT`         | `8000`       | port                                     |
| `ZR_TOKEN`        | *(none)*     | require this access token                |
| `ZR_MAX_MB`       | `200`        | max upload size                          |
| `ZR_MAX_CANDIDATES`| `2000000`   | per-job candidate cap                    |
| `ZR_MAX_SECONDS`  | `1800`       | per-job time cap                         |
| `ZR_MAX_JOBS`     | `2`          | concurrent jobs                          |

If you bind to a public interface, **set a token**:

```bash
ZR_HOST=0.0.0.0 ZR_TOKEN="$(openssl rand -hex 16)" python app.py
```

The app warns loudly on startup if you expose it publicly with no token.

### Docker

```bash
docker build -t zip-recovery .
docker run --rm -p 8000:8000 -e ZR_TOKEN="change-me" zip-recovery
```

The image installs `p7zip-full`, so `.7z` and AES `.zip` work out of the box,
and serves via gunicorn.

For a real deployment, put it behind a reverse proxy (Caddy, nginx, a Cloudflare
tunnel) that terminates TLS and, ideally, adds its own authentication in front
of the token.

## The fast path (true brute force)

This tool tests one password per archive-open, which is ideal for recall but
slow for blind cracking. When you need raw speed, extract the hash and run it on
a GPU:

```bash
7z2john secret.7z > hash.txt     # or: zip2john secret.zip > hash.txt
hashcat -m 11600 -a 0 hash.txt wordlist.txt -r rules/best64.rule   # 7z
hashcat -m 13600 -a 0 hash.txt wordlist.txt -r rules/best64.rule   # WinZip AES
```

## License

MIT. See `LICENSE`.
