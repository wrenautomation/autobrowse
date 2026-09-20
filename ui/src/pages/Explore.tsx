/**
 * Explore by model: a goal on a site, the agent's steps as they happen,
 * pause to act by hand, resume, stop, save the journal as a recording
 * and compile it. This is where a workflow is born.
 */
import { useEffect, useState } from "react";
import { api, type SessionView } from "../api.js";
import { href, useLoad } from "../hooks.js";

const LIVE = new Set(["starting", "running", "paused"]);

export function ExplorePage() {
  const { data, error, reload } = useLoad(() => api.agents(), []);
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
      <StartForm onStarted={(v) => (location.hash = href("explore", v.id))} />
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
  if (status === "failed") return "failed";
  return "";
}

function StartForm({ onStarted }: { onStarted: (v: SessionView) => void }) {
  const [site, setSite] = useState("google");
  const [goal, setGoal] = useState("");
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
          {data.status === "paused" && (
            <button
              type="button"
              className="primary"
              onClick={() => act(() => api.agentAction(id, "resume"))}
            >
              resume (agent goes on)
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
