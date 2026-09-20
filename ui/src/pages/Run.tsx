/** One run: the open gate first (that is what a person came for), then controls, results, plan. */
import { useState } from "react";
import { api, type RunStatusView } from "../api.js";
import { href, useLoad } from "../hooks.js";

export function RunPage({
  workflow,
  runKey,
  version,
}: {
  workflow: string;
  runKey: string;
  version: number;
}) {
  const { data, error, reload } = useLoad(
    () => api.run(workflow, runKey),
    [workflow, runKey, version],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (action: string) => {
    setBusy(action);
    setMsg(null);
    try {
      await api.action(workflow, runKey, action, note ? { note } : {});
      setNote("");
      reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">loading…</p>;
  const status = data.outcome?.status ?? (data.gate ? "waiting" : "running");
  return (
    <>
      <h1>
        {workflow}/{runKey} <span className={`pill ${status}`}>{status}</span>
        {data.paused ? <span className="pill">paused</span> : null}
      </h1>
      {data.gate ? (
        <GateCard gate={data.gate} note={note} setNote={setNote} act={act} busy={busy} />
      ) : null}
      <div className="row" style={{ marginBottom: 14 }}>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => act(data.paused ? "play" : "pause")}
        >
          {data.paused ? "play" : "pause"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => act("reset")}
          className="danger"
        >
          reset
        </button>
        <a href="#/runs" className="muted">
          all runs
        </a>
      </div>
      {msg && <p className="error">{msg}</p>}
      <h2>Steps</h2>
      <Results outcome={data.outcome} />
      <h2>Plan</h2>
      <pre>{JSON.stringify(data.plan, null, 2)}</pre>
    </>
  );
}

function GateCard({
  gate,
  note,
  setNote,
  act,
  busy,
}: {
  gate: NonNullable<RunStatusView["gate"]>;
  note: string;
  setNote: (s: string) => void;
  act: (a: string) => void;
  busy: string | null;
}) {
  return (
    <div className="card gate">
      <div className="muted">
        {gate.name === "human" ? "needs you" : `approve ${gate.name}?`} · at step{" "}
        <span className="mono">{gate.step}</span> · {new Date(gate.openedAt).toLocaleString()}
      </div>
      <p style={{ fontSize: 16, margin: "6px 0 10px" }}>{gate.prompt}</p>
      {gate.screenshot ? (
        <div className="shot" style={{ maxWidth: 640, marginBottom: 10 }}>
          <img src={api.artifact(gate.screenshot)} alt="where the browser stopped" />
        </div>
      ) : null}
      {gate.trace ? (
        <p className="mono muted">trace: npx playwright show-trace {gate.trace}</p>
      ) : null}
      <div className="row">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="note (optional)"
          className="grow"
        />
        <button
          type="button"
          className="primary"
          disabled={busy !== null}
          onClick={() => act("approve")}
        >
          {gate.name === "human" ? "done, continue" : "approve"}
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy !== null}
          onClick={() => act("reject")}
        >
          reject
        </button>
      </div>
    </div>
  );
}

function Results({ outcome }: { outcome: RunStatusView["outcome"] }) {
  const entries = Object.entries(outcome?.results ?? {}) as Array<
    [
      string,
      {
        status: string;
        detail: string;
        at: string;
        screenshot?: string;
        trace?: string;
        failure?: string;
      },
    ]
  >;
  if (!entries.length) return <p className="muted">no step has finished yet</p>;
  return (
    <ul className="timeline">
      {entries.map(([name, r]) => (
        <li key={name}>
          <span className="mono">{name}</span>
          <span>
            <span className={`pill ${r.status}`}>{r.status}</span>
          </span>
          <span>
            {r.detail}
            {r.screenshot ? (
              <>
                {" "}
                <a href={api.artifact(r.screenshot)} target="_blank" rel="noreferrer">
                  screenshot
                </a>
              </>
            ) : null}
            {r.failure ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() =>
                    api
                      .agentRepair(r.failure as string)
                      .then((v) => (location.hash = href("explore", v.id)))
                      .catch((e: Error) => alert(e.message))
                  }
                >
                  repair with agent
                </button>
              </>
            ) : null}
            <span className="muted"> · {new Date(r.at).toLocaleTimeString()}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
