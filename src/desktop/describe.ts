/** Words for a desktop act; no runtime deps so the UI can import it too. */
import type { DesktopOp } from "./types.js";
/** One line a person reads: what the act was, with typed text hidden when it was a secret. */
export function describeOp(op: DesktopOp, redacted = false): string {
  switch (op.op) {
    case "apps":
      return "list apps";
    case "open":
      return `open ${op.app}`;
    case "tree":
      return `look at ${op.app ?? "the front app"}`;
    case "click":
      return `click ${op.role ?? "control"} "${op.name}"${op.app ? ` in ${op.app}` : ""}`;
    case "type":
      return redacted ? "type (redacted)" : `type "${op.text}"`;
    case "key":
      return `press ${op.combo}`;
    case "shot":
      return "screenshot";
    case "shell":
      return `${op.root ? "root " : ""}shell: ${op.command}`;
    case "wait":
      return `wait ${op.ms}ms`;
  }
}
