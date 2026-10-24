/** The last lines of a CLI's output for a note or an error, with its login URL, long tokens and addresses masked. */
export function cliTail(out: string, urlRe: RegExp, lines = 3): string {
  return out
    .replace(urlRe, "<url>")
    .replace(/[A-Za-z0-9_.-]{30,}/g, "<tok>")
    .replace(/[A-Za-z0-9._%+-]+@/g, "***@")
    .trim()
    .split("\n")
    .slice(-lines)
    .join("\n");
}
