/** The proof is the compiled flow working on its own once: run it here, straight after compiling or editing. */
import { useState } from "react";
import { api, type Proof } from "../api.js";

export /** The proof is the compiled flow working on its own once: run it here, straight after compiling. */
function ProveButton({ workflow }: { workflow: string }) {
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<Proof | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const prove = async () => {
    setBusy(true);
    setErr(null);
    try {
      setProof(await api.prove(workflow));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const failed = proof?.steps.find((s) => s.status !== "done" && s.status !== "skipped");
  return (
    <span>
      <button type="button" disabled={busy} onClick={prove}>
        {busy ? "proving…" : proof ? "prove again" : "prove it runs"}
      </button>
      {proof ? (
        <span className={proof.status === "done" ? "muted" : "error"}>
          {" "}
          <span className={`pill ${proof.status === "done" ? "done" : "failed"}`}>
            {proof.status === "done" ? "proven" : `proof ${proof.status}`}
          </span>
          {failed ? ` at ${failed.name}: ${failed.detail}` : ""}
          {proof.output ? ` → ${JSON.stringify(proof.output)}` : ""}
        </span>
      ) : null}
      {err ? <span className="error"> {err}</span> : null}
    </span>
  );
}
