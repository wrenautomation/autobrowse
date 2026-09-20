/** What this worker is made of: the vendor behind each seam, the channels, the code sources. Names only. */
import { api } from "../api.js";
import { useLoad } from "../hooks.js";

export function StatusPage() {
  const status = useLoad(() => api.status(), []);
  const s = status.data;
  if (status.error) return <p className="error">{status.error}</p>;
  if (!s) return <p>{status.data === null ? "the worker reports no status" : "loading…"}</p>;
  const rows: Array<[string, string]> = [
    ["model", s.llm],
    [
      "browser",
      `${s.browser.tier} (${s.browser.channel}, ${s.browser.headless ? "headless" : "headed"}, ${s.browser.pace} pace)`,
    ],
    ["memory", s.memory],
    ["channels", s.channels.join(", ") || "none: gates wait on the Runs page"],
    ["login codes", s.codes.join(", ")],
    ["guards", s.guards],
    [
      "evaluator",
      s.evaluateEveryHours > 0 ? `every ${s.evaluateEveryHours} h` : "off (EVALUATE_EVERY_HOURS)",
    ],
    ["sentry", s.sentry ? "on" : "off"],
    ["workflows", s.workflows.join(", ")],
    ["up since", new Date(s.since).toLocaleString()],
  ];
  return (
    <>
      <h1>Status</h1>
      <p className="muted">
        One vendor per seam, chosen by settings. Names only; values never leave the worker.
      </p>
      <table>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
