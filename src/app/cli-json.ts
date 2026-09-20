import { readFile } from "node:fs/promises";

/** JSON as typed (`{"domain":"x.com"}`), from a file, or piped in (`-`). */
export async function readJson(arg: string): Promise<unknown> {
  const text = arg.trim().startsWith("{")
    ? arg
    : arg === "-"
      ? await new Promise<string>((r) => {
          let buf = "";
          process.stdin
            .setEncoding("utf8")
            .on("data", (c) => (buf += c))
            .on("end", () => r(buf));
        })
      : await readFile(arg, "utf8");
  return JSON.parse(text);
}
