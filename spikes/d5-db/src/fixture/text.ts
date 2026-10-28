// Deterministic chat-like text: Zipf-distributed vocabulary (s = 1.07) with
// real English function words at the top ranks, lognormal message lengths
// averaging ~300 bytes (06 §9 sizing assumption).
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

const COMMON = ("the i to a and you it is that of in for this on my be have just not we with so but was are " +
  "lol do what can if at like get all no me your they will about up one out know there yeah ok think good " +
  "how now time when or from going would really an got see then he people make some go game server voice " +
  "call tonight anyone want need channel stream screen share audio video mic later thanks").split(" ");

const SYL = ["ka", "lo", "mi", "ne", "ru", "ta", "vo", "shi", "pre", "con", "dar", "bel", "tor", "quin", "ex", "ul", "an", "is", "or", "en", "zy", "fa", "gri", "ple"];

export function buildVocab(size: number, rand: () => number): string[] {
  const seen = new Set<string>(COMMON);
  const words = [...COMMON];
  while (words.length < size) {
    const n = 2 + Math.floor(rand() * 3);
    let w = "";
    for (let i = 0; i < n; i++) w += SYL[Math.floor(rand() * SYL.length)];
    if (!seen.has(w)) { seen.add(w); words.push(w); }
  }
  return words;
}

export function zipfSampler(n: number, s: number, rand: () => number) {
  const cdf = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += 1 / Math.pow(i + 1, s); cdf[i] = acc; }
  for (let i = 0; i < n; i++) cdf[i]! /= acc;
  return () => {
    const u = rand();
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cdf[mid]! < u) lo = mid + 1; else hi = mid; }
    return lo;
  };
}

export function makeTextGen(seed: number) {
  const rand = rng(seed);
  const vocab = buildVocab(60_000, rand);
  const pick = zipfSampler(vocab.length, 1.07, rand);
  // lognormal word count, median ~30 words, capped so content stays <= 4000 chars
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
  return () => {
    const words = Math.max(1, Math.min(600, Math.round(Math.exp(3.4 + 0.9 * gauss()))));
    const out = new Array<string>(words);
    for (let i = 0; i < words; i++) out[i] = vocab[pick()]!;
    return out.join(" ");
  };
}
