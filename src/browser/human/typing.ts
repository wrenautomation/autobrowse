/**
 * How a person types: not one steady rate, but runs. A few keys come fast,
 * the next run slower; a word ends and there is a beat before the next;
 * a comma or a full stop is a longer beat; once in a while the hand stops
 * mid-word. Doubled letters come quicker. Every key is held down a moment
 * rather than tapped in zero time. Now and then a finger lands on the key
 * next door, the hand runs on a key or two, the eye catches it, and it
 * backs up and types them again.
 *
 * The plan is pure — text in, keystrokes with timings out — so it can be
 * tested and replayed; `Hands.type` only plays it.
 */
import { chance, drawInt, drawLog, drawMs, type Random } from "./draw.js";

export interface TypingStyle {
  /** Key held down, ms. */
  hold: [number, number];
  /** Gap to the next key at an ordinary tempo, ms. */
  gap: [number, number];
  /** Keys typed at one tempo before it changes. */
  run: [number, number];
  /** What a run's tempo multiplies the gap by: under 1 is a fast run, over 1 a slow one. */
  tempo: [number, number];
  /** Chance of a beat after a word. */
  wordBeat: number;
  /** A beat, ms: between words, and always after , . ; : ! ? */
  beat: [number, number];
  /** Chance per key of stopping mid-word, and how long. */
  stall: number;
  stallMs: [number, number];
  /** Longer than this is pasted, not typed: nobody types a whole post into a box. */
  pasteOver: number;
  /** Chance per letter of hitting a neighbouring key instead. */
  typo: number;
  /** Keys typed before the slip is noticed: the wrong one, then the word runs on (never past it). */
  typoRun: [number, number];
  /** Noticing the slip, ms; then Backspace, key after key, this far apart, ms. */
  notice: [number, number];
  erase: [number, number];
}

export interface Keystroke {
  /** One character, or `BACKSPACE`. */
  ch: string;
  /** Held this long. */
  hold: number;
  /** Then this long before the next key; 0 after the last. */
  after: number;
}

export const BACKSPACE = "Backspace";

const PUNCTUATION = /[.,;:!?]/;
const LETTER = /^[a-z]$/i;

/** The keys around each letter on a QWERTY board. Only letters slip: codes and digits stay exact. */
const NEIGHBOURS: Record<string, string> = {
  q: "wa",
  w: "qesa",
  e: "wrds",
  r: "etfd",
  t: "rygf",
  y: "tuhg",
  u: "yijh",
  i: "uokj",
  o: "iplk",
  p: "ol",
  a: "qwsz",
  s: "awedxz",
  d: "serfcx",
  f: "drtgvc",
  g: "ftyhbv",
  h: "gyujnb",
  j: "huikmn",
  k: "jiolm",
  l: "kop",
  z: "asx",
  x: "zsdc",
  c: "xdfv",
  v: "cfgb",
  b: "vghn",
  n: "bhjm",
  m: "njk",
};

/** The key next to `ch`, in its case. */
function slip(ch: string, random: Random): string {
  const near = NEIGHBOURS[ch.toLowerCase()] ?? ch;
  const k = near[Math.floor(random() * near.length)] ?? ch;
  return ch === ch.toLowerCase() ? k : k.toUpperCase();
}

export function typingPlan(text: string, s: TypingStyle, random: Random): Keystroke[] {
  const keys: Keystroke[] = [];
  const chars = [...text];
  let left = 0;
  let tempo = 1;
  for (const [i, ch] of chars.entries()) {
    if (left <= 0) {
      left = drawInt(s.run, random);
      tempo = drawLog(s.tempo, random);
    }
    left--;
    if (LETTER.test(ch) && chance(s.typo, random))
      keys.push(...mistype(chars, i, s, tempo, random));
    const next = chars[i + 1];
    let after = drawLog(s.gap, random) * tempo;
    if (next === ch) after *= 0.6;
    if (PUNCTUATION.test(ch) && next === " ") after += drawLog(s.beat, random);
    else if (ch === " " && chance(s.wordBeat, random)) after += drawLog(s.beat, random);
    else if (chance(s.stall, random)) after += drawLog(s.stallMs, random);
    keys.push({
      ch,
      hold: drawMs(s.hold, random),
      after: next === undefined ? 0 : Math.round(after),
    });
  }
  return keys;
}

/**
 * A slip at `chars[i]`: the wrong key, the rest of the run typed as meant
 * (or, a hand off by one key, all wrong), a beat, then Backspace over all
 * of it. The caller types `chars[i]` right after, so the text comes out exact.
 */
function mistype(
  chars: string[],
  i: number,
  s: TypingStyle,
  tempo: number,
  random: Random,
): Keystroke[] {
  const shifted = chance(0.3, random);
  const want = drawInt(s.typoRun, random);
  const run = [chars[i] ?? ""];
  for (let j = i + 1; run.length < want && LETTER.test(chars[j] ?? ""); j++)
    run.push(chars[j] ?? "");
  const typed = run.map((c, j) => (j === 0 || shifted ? slip(c, random) : c));
  const keys: Keystroke[] = typed.map((ch, j) => ({
    ch,
    hold: drawMs(s.hold, random),
    after: Math.round(
      j === typed.length - 1 ? drawLog(s.notice, random) : drawLog(s.gap, random) * tempo,
    ),
  }));
  for (const _ of typed)
    keys.push({ ch: BACKSPACE, hold: drawMs(s.hold, random), after: drawMs(s.erase, random) });
  return keys;
}
