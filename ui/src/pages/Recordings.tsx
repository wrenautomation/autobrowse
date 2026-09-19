/** Recordings on disk, one in detail with its screenshots, and the compile button: outline + source. */
import { useState } from "react";
import { api, type Compiled, type Recording } from "../api.js";
import { href, useLoad } from "../hooks.js";

export function RecordingsPage() {
  const { data, error } = useLoad(() => api.recordings(), []);
  return (
    <>
      <h1>Recordings</h1>
      <p className="muted">
        <span className="mono">
          autobrowse record &lt;name&gt; --site &lt;site&gt; [--url …] [--terminal]
        </span>{" "}
        makes one.
      </p>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Site</th>
            <th>Actions</th>
            <th>Commands</th>
            <th>Recorded</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((r) => (
            <tr key={r.name}>
              <td>
                <a href={href("recordings", r.name)}>{r.name}</a>
              </td>
              <td>{r.site}</td>
              <td>{r.actions.length}</td>
              <td>{r.commands.length}</td>
              <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
            </tr>
          ))}
          {data?.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                none yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

export function RecordingPage({ name }: { name: string }) {
  const { data, error } = useLoad(() => api.recording(name), [name]);
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [file, setFile] = useState("index.ts");
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">loading…</p>;
  const compile = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setCompiled(await api.compile(name));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h1>
        {data.name} <span className="pill">{data.site}</span>
      </h1>
      <div className="row" style={{ marginBottom: 14 }}>
        <button type="button" className="primary" disabled={busy} onClick={compile}>
          {busy ? "compiling…" : "compile to workflow"}
        </button>
        <a href="#/recordings" className="muted">
          all recordings
        </a>
        {msg && <span className="error">{msg}</span>}
      </div>
      {compiled ? (
        <div className="card">
          <div className="row">
            <strong>{compiled.outline.name}</strong>
            <span className="muted">
              {compiled.outline.steps
                .map((s) => `${s.name}${s.irreversible ? "!" : ""}`)
                .join(" → ")}
            </span>
            {compiled.usage ? (
              <span className="muted">
                · model {compiled.usage.inputTokens} in / {compiled.usage.outputTokens} out
              </span>
            ) : null}
          </div>
          <div className="row" style={{ margin: "10px 0" }}>
            {[...Object.keys(compiled.files), "outline.json"].map((f) => (
              <button
                type="button"
                key={f}
                className={file === f ? "primary" : ""}
                onClick={() => setFile(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <pre>
            {file === "outline.json"
              ? JSON.stringify(compiled.outline, null, 2)
              : compiled.files[file]}
          </pre>
        </div>
      ) : null}
      <h2>Actions</h2>
      <Actions rec={data} />
      {data.commands.length ? (
        <>
          <h2>Terminal</h2>
          <pre>{data.commands.join("\n")}</pre>
        </>
      ) : null}
    </>
  );
}

function Actions({ rec }: { rec: Recording }) {
  const label = (a: Recording["actions"][number]): string => {
    switch (a.kind) {
      case "navigate":
        return a.url;
      case "click":
        return `click ${a.target.name ?? a.target.text ?? a.target.tag}`;
      case "input":
        return `type "${a.value}" into ${a.target.name ?? a.target.placeholder ?? a.target.tag}${a.redacted ? " (redacted)" : ""}`;
      case "select":
        return `select ${a.value} in ${a.target.name ?? a.target.tag}`;
      case "press":
        return `press ${a.key}`;
      case "submit":
        return "submit";
      case "note":
        return `note: ${a.text}`;
      case "pause":
        return "⏸ paused";
      case "resume":
        return "▶ resumed";
    }
  };
  return (
    <div className="shots">
      {rec.actions.map((a) => (
        <div className="shot card" key={`${a.t}-${a.kind}`}>
          {a.screenshot ? (
            <img src={api.recordingFile(rec.name, a.screenshot)} alt="" loading="lazy" />
          ) : null}
          <div>
            <span className="muted mono">{(a.t / 1000).toFixed(1)}s</span> {label(a)}
          </div>
        </div>
      ))}
    </div>
  );
}
