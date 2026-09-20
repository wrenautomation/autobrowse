/** One compiled workflow: its outline as the edit surface (save = re-render), the rendered files, a proof. */
import { useEffect, useState } from "react";
import type { Outline } from "../../../src/compiler/outline.js";
import { api, type Compiled } from "../api.js";
import { ProveButton } from "../components/Prove.js";
import { href, useLoad } from "../hooks.js";

export function WorkflowPage({ name }: { name: string }) {
  const { data, error } = useLoad(() => api.outline(name), [name]);
  const [text, setText] = useState("");
  const [compiled, setCompiled] = useState<Compiled | null>(null);
  const [file, setFile] = useState("index.ts");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (data) setText(JSON.stringify(data, null, 2));
  }, [data]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">loading…</p>;
  const dirty = text !== JSON.stringify(compiled?.outline ?? data, null, 2);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const out = await api.saveOutline(name, JSON.parse(text) as Outline);
      setCompiled(out);
      setText(JSON.stringify(out.outline, null, 2));
      setMsg("saved and re-rendered; it is on the Runs page now");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const outline = compiled?.outline ?? data;
  return (
    <>
      <h1>
        {name} <span className="pill">{outline.site}</span>
      </h1>
      <p className="muted">
        {outline.description} · steps:{" "}
        {outline.steps.map((s) => `${s.name}${s.irreversible ? "!" : ""}`).join(" → ")}
      </p>
      <div className="row" style={{ marginBottom: 14 }}>
        <button type="button" className="primary" disabled={busy || !dirty} onClick={save}>
          {busy ? "saving…" : "save outline & re-render"}
        </button>
        <ProveButton workflow={name} />
        <a href={href("runs")} className="muted">
          runs
        </a>
        {msg && <span className={msg.startsWith("saved") ? "muted" : "error"}>{msg}</span>}
      </div>
      <div className="card">
        <label htmlFor="outline">
          outline.json — an op's hints, a value, a step's url; the name stays (it is the directory)
        </label>
        <textarea
          id="outline"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={Math.min(40, text.split("\n").length + 1)}
          spellCheck={false}
        />
      </div>
      {compiled ? (
        <div className="card">
          <div className="row" style={{ margin: "10px 0" }}>
            {Object.keys(compiled.files).map((f) => (
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
          <pre>{compiled.files[file] ?? compiled.files[Object.keys(compiled.files)[0] ?? ""]}</pre>
        </div>
      ) : null}
    </>
  );
}
