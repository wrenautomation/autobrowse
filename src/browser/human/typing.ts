/**
 * How a person types: not one steady rate, but runs. A few keys come fast,
 * the next run slower; a word ends and there is a beat before the next;
 * a comma or a full stop is a longer beat; once in a while the hand stops
 * mid-word. Doubled letters come quicker. Every key is held down a moment
 * rather than tapped in zero time.
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
}

export interface Keystroke {
  ch: string;
  /** Held this long. */
  hold: number;
  /** Then this long before the next key; 0 after the last. */
  after: number;
}

const PUNCTUATION = /[.,;:!?]/;

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
