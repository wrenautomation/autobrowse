/**
 * Asking for a secret on this terminal. Nothing is echoed while it is
 * typed and nothing is printed after: a value given here never reaches a
 * shell history, a process argument, a file or a log. It goes to the
 * caller and nowhere else.
 */
import type { ReadStream, WriteStream } from "node:tty";

export interface Terminal {
  in: ReadStream;
  out: WriteStream;
}

const ETX = 3;
const BACKSPACE = new Set([8, 127]);
const ENTER = new Set([10, 13]);

/** One line typed with the echo off. Ctrl-C throws; the terminal is always put back. */
export function askSecret(question: string, io?: Partial<Terminal>): Promise<string> {
  const input = (io?.in ?? process.stdin) as ReadStream;
  const out = (io?.out ?? process.stderr) as WriteStream;
  if (!input.isTTY || typeof input.setRawMode !== "function")
    return Promise.reject(new Error("a secret can only be typed on a terminal"));
  out.write(question);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    // Bytes, not characters: a terminal delivers an é as two of them, and
    // only the whole line decodes to what was typed.
    let bytes: number[] = [];
    const typed = () => Buffer.from(bytes).toString("utf8");
    const stop = (finish: () => void) => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      out.write("\n");
      finish();
    };
    const onData = (buf: Buffer) => {
      for (const byte of buf) {
        if (byte === ETX) return stop(() => reject(new Error("cancelled")));
        if (ENTER.has(byte)) return stop(() => resolve(typed()));
        // Backspace drops a whole character, however many bytes it took.
        if (BACKSPACE.has(byte)) {
          bytes = [...Buffer.from([...typed()].slice(0, -1).join(""), "utf8")];
          continue;
        }
        if (byte < 32 || byte === 127) continue;
        bytes.push(byte);
      }
    };
    input.on("data", onData);
  });
}

/**
 * The same secret twice, or an error. The second ask is what catches a
 * typo, since neither is shown; `rules` refuses what a site would refuse
 * anyway, before a browser is opened.
 */
export async function askSecretTwice(
  what: string,
  o: { minLength?: number; io?: Partial<Terminal> } = {},
): Promise<string> {
  const min = o.minLength ?? 12;
  const first = await askSecret(`${what}: `, o.io);
  if (first.length < min) throw new Error(`too short: ${min} characters or more`);
  const again = await askSecret(`${what} again: `, o.io);
  if (first !== again) throw new Error("the two did not match");
  return first;
}
