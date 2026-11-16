// Zip-Recovery client-side candidate engine.
// Pure logic, no DOM, no network. Imports cleanly in both the browser and Node.
// This mirrors engine.py's generator so the web and CLI tools behave the same.

export const LEET_MAP = {
  a: ["@", "4"], e: ["3"], i: ["1", "!"], o: ["0"],
  s: ["$", "5"], t: ["7"], l: ["1"], g: ["9"], b: ["8"],
};

export const COMMON_SUFFIXES = ["", "!", "1", "123", "?", "#", "$", "12", "2",
  "01", "1234", "!!", "00", "007", "69", "99", "11", "22"];
export const COMMON_PREFIXES = ["!", "1", "@"];

function* kCase(word) {
  const seen = new Set();
  const cap = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  const title = word.replace(/\w\S*/g, w =>
    w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  const swap = [...word].map(c =>
    c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join("");
  for (const v of [word, word.toLowerCase(), word.toUpperCase(), cap, swap, title]) {
    if (!seen.has(v)) { seen.add(v); yield v; }
  }
}

function* kAffix(word, digits, years) {
  for (const suf of COMMON_SUFFIXES) yield word + suf;
  for (const d of digits) yield word + d;
  for (const y of years) { yield word + y; yield word + "!" + y; yield word + "@" + y; }
  for (const pre of COMMON_PREFIXES) yield pre + word;
}

function* leetVariants(word, maxVariants) {
  const options = [...word].map(ch => {
    const low = ch.toLowerCase();
    return LEET_MAP[low] ? [ch, ...LEET_MAP[low]] : [ch];
  });
  let count = 0;
  // bounded cartesian product
  const idx = new Array(options.length).fill(0);
  while (true) {
    yield idx.map((i, p) => options[p][i]).join("");
    if (++count >= maxVariants) return;
    let p = options.length - 1;
    while (p >= 0) {
      idx[p]++;
      if (idx[p] < options[p].length) break;
      idx[p] = 0; p--;
    }
    if (p < 0) return;
  }
}

function* kDup(word) {
  yield word + word;
  yield [...word].reverse().join("");
  yield word + [...word].reverse().join("");
}

export function parseRange(spec) {
  const out = [];
  for (let part of String(spec).split(",")) {
    part = part.trim();
    if (!part) continue;
    const m = part.match(/^(-?\d+)-(-?\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      const step = b >= a ? 1 : -1;
      for (let n = a; step > 0 ? n <= b : n >= b; n += step) out.push(String(n));
    } else {
      out.push(part);
    }
  }
  return out;
}

export function loadWords(wordlistText, hints) {
  const words = [], seen = new Set();
  const add = w => {
    w = (w || "").replace(/[\r\n]+$/, "");
    if (w && !seen.has(w)) { seen.add(w); words.push(w); }
  };
  for (const h of hints || []) add(h);
  if (wordlistText) for (const line of wordlistText.split("\n")) add(line);
  return words;
}

// Yields unique candidates, most-likely-first. opts mirror the Python engine.
export function* generate(words, opts = {}) {
  const kits = new Set(opts.kits || ["base", "case", "affix", "leet"]);
  const digits = parseRange(opts.digits ?? "0-99");
  const years = parseRange(opts.years ?? "2015-2026");
  const leetCap = opts.leetCap ?? 64;
  const combo = !!opts.combo;
  const comboSeps = opts.comboSeps || ["-", "_", ""];
  const seen = new Set();
  const emit = c => (c && !seen.has(c)) ? (seen.add(c), true) : false;

  for (const w of words) {
    if (kits.has("base") && emit(w)) yield w;
    if (kits.has("case")) for (const v of kCase(w)) if (emit(v)) yield v;
  }
  if (kits.has("affix"))
    for (const w of words) for (const v of kAffix(w, digits, years)) if (emit(v)) yield v;
  if (kits.has("leet"))
    for (const w of words) for (const v of leetVariants(w, leetCap)) if (emit(v)) yield v;
  if (kits.has("dup"))
    for (const w of words) for (const v of kDup(w)) if (emit(v)) yield v;
  if (kits.has("combo") && combo)
    for (const a of words) for (const b of words)
      if (a !== b) for (const sep of comboSeps) if (emit(a + sep + b)) yield a + sep + b;
}
