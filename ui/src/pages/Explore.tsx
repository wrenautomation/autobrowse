/**
 * Explore by model: a goal on a site, the agent's steps as they happen,
 * pause to act by hand, resume, stop, save the journal as a recording
 * and compile it. This is where a workflow is born.
 */
import { useEffect, useState } from "react";
import { api, type Proposal, type SessionView } from "../api.js";
import { href, useLoad } from "../hooks.js";

const LIVE = new Set(["starting", "running", "paused", "needs-human"]);

export function ExplorePage() {
  const { data, error, reload } = useLoad(() => api.agents(), []);
  const [prefill, setPrefill] = useState<Proposal | null>(null);
  useEffect(() => {
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [reload]);
  return (
    <>
      <h1>Explore</h1>
      <p className="muted">
        The agent finds the way once; save the journal, compile it, run the flow forever. Pause any
        time to do a step by hand: it lands in the same journal.
      </p>
      <StartForm onStarted={(v) => (location.hash = href("explore", v.id))} prefill={prefill} />
      <Proposals onPick={setPrefill} />
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Goal</th>
            <th>Site</th>
            <th>Status</th>
            <th>Steps</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((s) => (
            <tr key={s.id}>
              <td>
                <a href={href("explore", s.id)}>{s.goal}</a>
              </td>
              <td>{s.site}</td>
              <td>
                <span className={`pill ${pillClass(s.status)}`}>{s.status}</span>
              </td>
              <td>{s.steps.length}</td>
              <td className="muted">{new Date(s.startedAt).toLocaleString()}</td>
            </tr>
          ))}
          {data?.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                no sessions yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function pillClass(status: SessionView["status"]): string {
  if (status === "done") return "done";
  if (status === "running" || status === "starting") return "running";
  if (status === "paused") return "waiting";
  if (status === "needs-human") return "needs-human";
  if (status === "failed") return "failed";
  return "";
}

/**
 * What the evaluator thinks deserves a workflow: each row is one click
 * into the form above. Computed on demand (one model call), not on load.
 */
function Proposals({ onPick }: { onPick: (p: Proposal) => void }) {
  const [data, setData] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.proposals();
      setData(r.proposals);
      setMsg(`model ${r.usage.inputTokens} in / ${r.usage.outputTokens} out`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="row">
        <strong>What deserves a workflow</strong>
        <button type="button" disabled={busy} onClick={load}>
          {busy ? "looking…" : data ? "look again" : "ask the evaluator"}
        </button>
        <span className="muted">
          from flow failures, sessions and recordings {msg ? `· ${msg}` : ""}
        </span>
      </div>
      {data?.length === 0 && <p className="muted">nothing recurring yet</p>}
      {data?.map((p) => (
        <div className="row" key={p.title} style={{ marginTop: 8 }}>
          <span className="pill">{p.occurrences}×</span>
          <span className="grow">
            <strong>{p.title}</strong> <span className="muted">{p.why}</span>
            {p.covered ? <span className="pill done">covered</span> : null}
          </span>
          <button type="button" className="primary" onClick={() => onPick(p)}>
            explore this
          </button>
        </div>
      ))}
    </div>
  );
}

function StartForm({
  onStarted,
  prefill,
}: {
  onStarted: (v: SessionView) => void;
  prefill: Proposal | null;
}) {
  const [site, setSite] = useState("google");
  const [goal, setGoal] = useState("");
  useEffect(() => {
    if (!prefill) return;
    setSite(prefill.site);
    setGoal(prefill.goal);
  }, [prefill]);
  const [url, setUrl] = useState("");
  const [inputs, setInputs] = useState("");
  const [maxSteps, setMaxSteps] = useState("25");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const kv = Object.fromEntries(
        inputs
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const i = l.indexOf("=");
            return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
          }),
      );
      const v = await api.agentStart({
        site,
        goal,
        ...(url ? { url } : {}),
        ...(Object.keys(kv).length ? { inputs: kv } : {}),
        maxSteps: Number(maxSteps) || 25,
      });
      onStarted(v);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <div className="row">
        <div className="field">
          <label htmlFor="site">site (or site@account)</label>
          <input id="site" value={site} onChange={(e) => setSite(e.target.value)} />
        </div>
        <div className="field grow">
          <label htmlFor="goal">goal</label>
          <input
            id="goal"
            value={goal}
            placeholder="open Personal info and report the display name"
            onChange={(e) => setGoal(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="steps">max steps</label>
          <input id="steps" value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <div className="field grow">
          <label htmlFor="url">start URL (optional)</label>
          <input id="url" value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="field grow">
          <label htmlFor="inputs">inputs, one `name=value` per line (a file, a domain)</label>
          <textarea
            id="inputs"
            rows={2}
            value={inputs}
            onChange={(e) => setInputs(e.target.value)}
          />
        </div>
      </div>
      <div className="row">
        <button type="button" className="primary" disabled={busy || !goal} onClick={submit}>
          {busy ? "starting…" : "explore"}
        </button>
        {msg && <span className="error">{msg}</span>}
      </div>
    </div>
  );
}

export function AgentPage({ id }: { id: string }) {
  const { data, error, reload } = useLoad(() => api.agent(id), [id]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const live = data ? LIVE.has(data.status) : true;
  useEffect(() => {
    if (!live) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [live, reload]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">loading…</p>;
  const act = async (fn: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const suggested = data.goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const closed = data.status === "closed";
  return (
    <>
      <h1>
        {data.goal} <span className={`pill ${pillClass(data.status)}`}>{data.status}</span>
      </h1>
      <p className="muted">
        {data.site} · {data.steps.length} steps · model {data.usage.inputTokens} in /{" "}
        {data.usage.outputTokens} out · <a href="#/explore">all sessions</a>
      </p>
      <div className="card">
        <div className="row">
          {data.status === "running" && (
            <button type="button" onClick={() => act(() => api.agentAction(id, "pause"))}>
              pause (I take over)
            </button>
          )}
          {(data.status === "paused" || data.status === "needs-human") && (
            <button
              type="button"
              className="primary"
              onClick={() => act(() => api.agentAction(id, "resume"))}
            >
              {data.status === "needs-human" ? "done, agent goes on" : "resume (agent goes on)"}
            </button>
          )}
          {live && (
            <button
              type="button"
              className="danger"
              onClick={() => act(() => api.agentAction(id, "stop"))}
            >
              stop
            </button>
          )}
          {!closed && (
            <>
              <input
                value={name}
                placeholder={suggested}
                onChange={(e) => setName(e.target.value)}
                style={{ width: 260 }}
              />
              <button
                type="button"
                className="primary"
                onClick={() => act(() => api.agentSave(id, name || suggested))}
              >
                save recording
              </button>
              <button type="button" onClick={() => act(() => api.agentAction(id, "close"))}>
                close browser
              </button>
            </>
          )}
          {data.recordingName && (
            <a href={href("recordings", data.recordingName)}>
              recording {data.recordingName} → compile
            </a>
          )}
          {msg && <span className="error">{msg}</span>}
        </div>
        {data.status === "needs-human" && (
          <p>
            <strong>needs you:</strong> {data.prompt}. Do it in the browser window, then resume.
          </p>
        )}
        {data.status === "paused" && (
          <p className="muted">
            The browser window is yours: click and type; every act is journaled. Resume when done.
          </p>
        )}
        {data.summary && (
          <p>
            <strong>{data.achieved ? "achieved" : "not achieved"}:</strong> {data.summary}
          </p>
        )}
        {data.error && <p className="error">{data.error}</p>}
      </div>
      <h2>Steps</h2>
      <div className="shots">
        {data.steps.map((s, i) => (
          <div className="shot card" key={s.n}>
            {s.screenshot ? <img src={api.agentShot(id, i)} alt="" loading="lazy" /> : null}
            <div>
              <span className="muted mono">{s.n}.</span> {s.step?.thought ?? "(unparsable reply)"}
            </div>
            <div className="mono muted">
              {describe(s)} {s.error ? <span className="error">✗ {s.error}</span> : "✓"}
            </div>
          </div>
        ))}
        {data.steps.length === 0 && <p className="muted">{live ? "thinking…" : "no steps"}</p>}
      </div>
    </>
  );
}

function describe(s: SessionView["steps"][number]): string {
  const a = s.step?.action;
  if (!a) return "-";
  const at = "ref" in a ? ` [${a.ref}]` : "";
  const what =
    a.cmd === "open" ? ` ${a.url}` : a.cmd === "fill" || a.cmd === "select" ? ` "${a.value}"` : "";
  return `${a.cmd}${at}${what}`;
}
