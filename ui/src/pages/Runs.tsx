/** Every run the registry knows, and a form to start one from a workflow's plan schema. */
import { useState } from "react";
import { api, type WorkflowInfo } from "../api.js";
import { href, useLoad } from "../hooks.js";

export function RunsPage({ version }: { version: number }) {
  const runs = useLoad(() => api.runs(), [version]);
  const workflows = useLoad(() => api.workflows(), []);
  return (
    <>
      <h1>Runs</h1>
      {runs.error && <p className="error">{runs.error}</p>}
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th>Last step</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {(runs.data ?? []).map((r) => (
            <tr key={`${r.workflow}/${r.key}`}>
              <td>
                <a href={href("runs", r.workflow, r.key)}>
                  {r.workflow}/{r.key}
                </a>
              </td>
              <td>
                <span className={`pill ${r.status}`}>{r.status}</span>
                {r.gate ? <span className="muted"> · {r.gate}</span> : null}
              </td>
              <td className="mono">{r.lastStep ?? "—"}</td>
              <td className="muted">{new Date(r.updatedAt).toLocaleString()}</td>
            </tr>
          ))}
          {runs.data?.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                nothing yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <h2>Start a run</h2>
      {workflows.data ? <StartForm workflows={workflows.data} /> : null}
    </>
  );
}

/** Scalars get a field each; anything else is JSON. The key is the run's identity (a domain, an email). */
function StartForm({ workflows }: { workflows: WorkflowInfo[] }) {
  const [name, setName] = useState(workflows[0]?.name ?? "");
  const w = workflows.find((x) => x.name === name);
  const [key, setKey] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!w) return null;
  const props = Object.entries(w.plan.properties ?? {}).filter(([k]) => k !== "dryRun");
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const plan: Record<string, unknown> = { dryRun };
      for (const [k, p] of props) {
        const raw = values[k];
        if (raw === undefined || raw === "") continue;
        plan[k] =
          p.type === "string" ? raw : p.type === "boolean" ? raw === "true" : JSON.parse(raw);
      }
      await api.start(w.name, key, plan);
      setMsg(`started ${w.name}/${key}`);
      location.hash = href("runs", w.name, key);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="row">
        <div className="field grow">
          <label htmlFor="wf">workflow</label>
          <select id="wf" value={name} onChange={(e) => setName(e.target.value)}>
            {workflows.map((x) => (
              <option key={x.name} value={x.name}>
                {x.name} — {x.description}
              </option>
            ))}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="key">key (one run per key)</label>
          <input
            id="key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="wren-six.com"
          />
        </div>
      </div>
      {props.map(([k, p]) => (
        <div className="field" key={k}>
          <label htmlFor={`f-${k}`}>
            {k}
            {p.description ? ` — ${p.description}` : ""}
            {w.plan.required?.includes(k) ? "" : " (optional)"}
          </label>
          {p.type === "string" ? (
            <input
              value={values[k] ?? ""}
              onChange={(e) => setValues({ ...values, [k]: e.target.value })}
            />
          ) : p.type === "boolean" ? (
            <select
              id={`f-${k}`}
              value={values[k] ?? String(p.default ?? "")}
              onChange={(e) => setValues({ ...values, [k]: e.target.value })}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <textarea
              id={`f-${k}`}
              value={values[k] ?? ""}
              placeholder="JSON"
              onChange={(e) => setValues({ ...values, [k]: e.target.value })}
              style={{ minHeight: 60 }}
            />
          )}
        </div>
      ))}
      <div className="row">
        <label className="row" style={{ margin: 0 }} htmlFor="dryRun">
          <input
            id="dryRun"
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
            style={{ width: "auto" }}
          />
          dry run (stop before anything irreversible)
        </label>
        <span className="grow" />
        <button type="button" className="primary" disabled={busy || !key} onClick={submit}>
          start
        </button>
      </div>
      {msg && <p className={msg.startsWith("started") ? "muted" : "error"}>{msg}</p>}
      <p className="muted">
        steps: {w.steps.map((s) => `${s.name}${s.irreversible ? "!" : ""}`).join(" → ")} (! =
        irreversible)
      </p>
    </div>
  );
}
