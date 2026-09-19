/** Plain-text wording for an event, shared by every channel that shows text. */
import type { RunEvent } from "../engine/events.js";
import { runId } from "../engine/events.js";

export interface Rendered {
  subject: string;
  text: string;
}

export function render(event: RunEvent, opts: { cli?: string } = {}): Rendered | null {
  const id = runId(event.run);
  const cli = opts.cli ?? "autobrowse";
  switch (event.type) {
    case "gate-opened": {
      const g = event.gate;
      const subject =
        g.name === "human" ? `${id}: needs you at ${g.step}` : `${id}: approve ${g.name}?`;
      const text = [
        g.prompt,
        g.screenshot ? `screenshot: ${g.screenshot}` : "",
        g.trace ? `trace: npx playwright show-trace ${g.trace}` : "",
        "",
        `reply yes/no, or: ${cli} approve ${event.run.workflow} ${event.run.key} ${g.name}`,
      ]
        .filter((l) => l !== "")
        .join("\n");
      return { subject, text };
    }
    case "finished":
      return { subject: `${id}: ${event.status}`, text: event.summary };
    default:
      return null;
  }
}
