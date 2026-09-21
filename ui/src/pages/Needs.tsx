/**
 * Needs: what only the person can give (logins, keys, consents, the phone
 * link, money, decisions), each row with what it unlocks and the command
 * that ingests it. A check clears a row by itself; a decision is marked
 * done here with a note. What `autobrowse needs` prints, without a terminal.
 */
import { useState } from "react";
import { api, type NeedView } from "../api.js";
import { useLoad } from "../hooks.js";

export function NeedsPage() {
  const [version, setVersion] = useState(0);
  const [all, setAll] = useState(false);
  const rows = useLoad(() => api.needs(), [version]);
  const refresh = () => setVersion((v) => v + 1);
  if (rows.error) return <p className="error">{rows.error}</p>;
  if (!rows.data) return <p>checking…</p>;
  const { titles } = rows.data;
  const open = rows.data.rows.filter((r) => !r.done);
  const shown = all ? rows.data.rows : open;
  const kinds = [...new Set(shown.map((r) => r.kind))];
  return (
    <>
      <h2>Needs</h2>
      <p className="muted">
        {open.length} open of {rows.data.rows.length}. Each row says what it unlocks and the command
        that takes it in; a check clears itself, a decision is marked done here.{" "}
        <button type="button" onClick={() => setAll((v) => !v)}>
          {all ? "open only" : "show all"}
        </button>
      </p>
      {kinds.map((kind) => (
        <section key={kind}>
          <h3>{titles[kind] ?? kind}</h3>
          <table>
            <tbody>
              {shown
                .filter((r) => r.kind === kind)
                .map((r) => (
                  <Need key={r.id} row={r} refresh={refresh} />
                ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}

function Need({ row: r, refresh }: { row: NeedView; refresh: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr className={r.done ? "muted" : ""}>
      <td>
        <strong>{r.id}</strong>
        {r.after ? <div className="muted">after {r.after}</div> : null}
      </td>
      <td>
        <div>{r.what}</div>
        <div className="muted">→ {r.unlocks}</div>
        {r.how.map((h) => (
          <div key={h}>
            <code>{h}</code>
          </div>
        ))}
        {r.note ? <div className="muted">note: {r.note}</div> : null}
        {error ? <div className="error">{error}</div> : null}
      </td>
      <td>
        {r.done ? (
          <>
            <span className="muted">done ({r.by})</span>{" "}
            {r.by === "you" ? (
              <button type="button" disabled={busy} onClick={() => act(() => api.needUndo(r.id))}>
                undo
              </button>
            ) : null}
          </>
        ) : r.checked ? (
          <span className="muted">clears itself</span>
        ) : (
          <>
            <input
              placeholder="note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />{" "}
            <button
              type="button"
              disabled={busy}
              onClick={() => act(() => api.needDone(r.id, note || undefined))}
            >
              done
            </button>
          </>
        )}
      </td>
    </tr>
  );
}
