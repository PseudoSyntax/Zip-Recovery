#!/usr/bin/env python3
"""
recall - command-line front end for the Zip-Recovery engine.

Recover a forgotten password for a .7z or .zip archive you own, by
generating variations of words you might have used.

Examples:
  python recall.py secret.7z -H Fluffy -H Summer -w mywords.txt
  python recall.py backup.zip -H oldpass --kits base,case,affix --years 2010-2026
  python recall.py secret.7z -w big.txt --dry-run --max 50
"""

import argparse
import os
import sys

import engine


def main(argv=None):
    p = argparse.ArgumentParser(
        prog="recall",
        description="Recover a forgotten password for a .7z/.zip archive you own.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "KITS: base, case, affix, leet, dup, combo (combo needs --combo)\n\n"
            "For a true brute force (not recall), extract the hash and use a GPU:\n"
            "  7z2john secret.7z > hash.txt   # or zip2john for .zip\n"
            "  hashcat -m 11600 -a 0 hash.txt big.txt -r rules/best64.rule\n"
        ),
    )
    p.add_argument("archive", help="path to the .7z or .zip file")
    p.add_argument("-w", "--wordlist", action="append", default=[],
                   help="wordlist file (repeatable)")
    p.add_argument("-H", "--hint", action="append", default=[],
                   help="a word you think you used (repeatable, tried first)")
    p.add_argument("--kits", default="base,case,affix,leet")
    p.add_argument("--years", default="2015-2026")
    p.add_argument("--digits", default="0-99")
    p.add_argument("--leet-cap", type=int, default=64)
    p.add_argument("--combo", action="store_true")
    p.add_argument("--combo-sep", default="-,_,.")
    p.add_argument("--backend", choices=["auto", "py7zr", "cli", "zipfile"],
                   default="auto")
    p.add_argument("--max", type=int, default=0, help="stop after N candidates")
    p.add_argument("--max-seconds", type=int, default=0)
    p.add_argument("--dry-run", action="store_true",
                   help="print candidates instead of testing")
    p.add_argument("--out", default="found_password.txt")
    args = p.parse_args(argv)

    words = engine.load_words(args.wordlist, args.hint)
    if not words:
        p.error("no words to work from - give --hint and/or --wordlist")
    kits = {k.strip() for k in args.kits.split(",") if k.strip()}

    if args.dry_run:
        n = 0
        for c in engine.generate(words, kits, engine.parse_range(args.digits),
                                 engine.parse_range(args.years), args.leet_cap,
                                 args.combo, tuple(args.combo_sep.split(","))):
            print(c)
            n += 1
            if args.max and n >= args.max:
                break
        print(f"\n[i] {n} candidates ({len(words)} base words, kits={sorted(kits)})",
              file=sys.stderr)
        return 0

    if not os.path.exists(args.archive):
        p.error(f"archive not found: {args.archive}")

    def progress(tried, last, rate):
        tail = f" last: {last[:32]}" if last else ""
        print(f"\r[.] tried {tried} ({rate:.0f}/s){tail:<40}", end="",
              file=sys.stderr)

    try:
        res = engine.recover(
            args.archive, words, kits=kits, digits=args.digits, years=args.years,
            leet_cap=args.leet_cap, combo=args.combo,
            combo_seps=tuple(args.combo_sep.split(",")),
            forced_backend=None if args.backend == "auto" else args.backend,
            max_candidates=args.max, max_seconds=args.max_seconds,
            progress_cb=progress,
        )
    except engine.BackendError as e:
        print(f"\n[!] {e}", file=sys.stderr)
        return 2

    print(f"\n[i] backend: {res['backend']}", file=sys.stderr)
    if res["found"]:
        print(f"\n[+] PASSWORD FOUND: {res['password']}")
        print(f"[+] {res['tried']} tries in {res['seconds']:.1f}s")
        try:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(res["password"] + "\n")
            print(f"[+] written to {args.out}")
        except OSError:
            pass
        return 0

    print(f"\n[-] no match. tried {res['tried']} in {res['seconds']:.1f}s.",
          file=sys.stderr)
    print("[-] add more hints/wordlists or widen --years/--digits/--kits.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
