/** Every run the registry knows, and a form to start one from a workflow's plan schema. */
import { useCallback, useEffect, useState } from "react";
import {
  applyRunEvent,
  compareRows,
  cursorOf,
  LIST_LIMIT,
  placeRow,
  type RunRow,
} from "../../../src/engine/rows.js";
import { api, type RunEvent, type WorkflowInfo } from "../api.js";
import { href, useLoad } from "../hooks.js";

/** The list is loaded once a page at a time; each live event folds into it, as the registry folds it. */
function useRuns(event: RunEvent | null) {
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (before?: string) => {
    setBusy(true);
    try {
      const page = await api.runs({ limit: LIST_LIMIT, ...(before ? { before } : {}) });
      setRows((prev) => merge(before ? (prev ?? []) : [], page));
      setMore(page.length === LIST_LIMIT);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!event) return;
    setRows((prev) => {
      if (!prev) return prev;
      const id = (r: RunRow) => `${r.workflow}/${r.key}`;
      const have = prev.find((r) => id(r) === `${event.run.workflow}/${event.run.key}`) ?? null;
      return placeRow(prev, applyRunEvent(have, event));
    });
  }, [event]);
  const last = rows?.[rows.length - 1];
  return { rows, error, busy, more, loadMore: () => last && load(cursorOf(last)) };
}

/** Newer rows replace older ones with the same id; newest first. */
function merge(prev: RunRow[], next: RunRow[]): RunRow[] {
  const byId = new Map(prev.map((r) => [`${r.workflow}/${r.key}`, r]));
  for (const r of next) byId.set(`${r.workflow}/${r.key}`, r);
  return [...byId.values()].sort(compareRows);
}

export function RunsPage({ event }: { event: RunEvent | null }) {
  const runs = useRuns(event);
  const [proved, setProved] = useState(0);
  const workflows = useLoad(() => api.workflows(), [proved]);
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
          {(runs.rows ?? []).map((r) => (
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
          {runs.rows?.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                nothing yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {runs.more && (
        <button type="button" disabled={runs.busy} onClick={() => void runs.loadMore()}>
          {runs.busy ? "loading…" : "older runs"}
        </button>
      )}
      <h2>Start a run</h2>
      {workflows.data ? (
        <StartForm workflows={workflows.data} onProved={() => setProved((n) => n + 1)} />
      ) : null}
    </>
  );
}

/** Scalars get a field each; anything else is JSON. The key is the run's identity (a domain, an email). */
/** Compiled flows carry their last proof run; a draft has none yet. One click runs a proof here. */
function ProofLine({ w, onProved }: { w: WorkflowInfo; onProved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const proof = w.proof;
  if (proof === undefined) return null;
  const prove = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.prove(w.name);
      onProved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const button = (
    <button type="button" disabled={busy} onClick={prove} style={{ marginLeft: 8 }}>
      {busy ? "proving…" : proof ? "prove again" : "prove"}
    </button>
  );
  if (proof === null)
    return (
      <p className="muted">
        draft: compiled, never run (a proof runs it once on plan defaults; gates are declined)
        {button}
        {err ? <span className="error"> {err}</span> : null}
      </p>
    );
  const failed = proof.steps.find((s) => s.status !== "done" && s.status !== "skipped");
  return (
    <p className={proof.status === "done" ? "muted" : "error"}>
      <span className={`pill ${proof.status === "done" ? "done" : "failed"}`}>
        {proof.status === "done" ? "proven" : `proof ${proof.status}`}
      </span>{" "}
      {new Date(proof.at).toLocaleString()}
      {failed ? ` at ${failed.name}: ${failed.detail}` : ""}
      {proof.output ? ` → ${JSON.stringify(proof.output)}` : ""}
      {button}
      {err ? <span> {err}</span> : null}
    </p>
  );
}

function StartForm({ workflows, onProved }: { workflows: WorkflowInfo[]; onProved: () => void }) {
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
      <ProofLine w={w} onProved={onProved} />
      {w.proof !== undefined ? (
        <p>
          <a href={href("workflows", w.name)}>edit outline</a>
        </p>
      ) : null}
    </div>
  );
}
