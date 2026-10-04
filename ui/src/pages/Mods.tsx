/**
 * Mods: what others learned about a site, added here (designs/2026-10-04-mods.md).
 * Installed mods with what they ask for and what they did, npm search, add a
 * data mod after its permission screen and a yes, remove. Code mods (a
 * workflow) are added from the CLI only, with `--trust`.
 */
import { useState } from "react";
import { api, type ModCheck, type ModFound, type ModView } from "../api.js";
import { useLoad } from "../hooks.js";

export function ModsPage() {
  const [version, setVersion] = useState(0);
  const mods = useLoad(() => api.mods(), [version]);
  const refresh = () => setVersion((v) => v + 1);
  return (
    <>
      <h2>Mods</h2>
      <p className="muted">
        Walks, screens, fixes and logins others packed. Your own files always win; what worked is
        kept in your files and outlives the mod.
      </p>
      {mods.error ? <p className="error">{mods.error}</p> : null}
      {mods.data && !mods.data.length ? <p className="muted">none added yet</p> : null}
      {mods.data?.map((m) => (
        <Installed key={m.name} mod={m} refresh={refresh} />
      ))}
      <Add refresh={refresh} />
    </>
  );
}

function Installed({ mod: m, refresh }: { mod: ModView; refresh: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const runs = useLoad(
    () => Promise.all(m.walks.map((w) => api.runs({ workflow: w, limit: 100 }))),
    [m.name, m.at],
  );
  const remove = async () => {
    if (!window.confirm(`remove ${m.name}? what it taught your files stays`)) return;
    try {
      await api.removeMod(m.name);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section>
      <h3>
        {m.name}@{m.version}
        {m.trusted ? <span className="muted"> (trusted code)</span> : null}{" "}
        <button type="button" onClick={remove}>
          remove
        </button>
      </h3>
      <pre>{m.permissions.slice(1).join("\n")}</pre>
      <p className="muted">
        from {m.source}, added {m.at.slice(0, 10)}. Used: {m.kept.screens} screen(s) and{" "}
        {m.kept.fixes} fix(es) kept
        {m.walks.length
          ? `; ${runs.data ? runs.data.reduce((n, r) => n + r.length, 0) : "…"} run(s) of ${m.walks.join(", ")}`
          : ""}
        .
      </p>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

function Add({ refresh }: { refresh: () => void }) {
  const [words, setWords] = useState("");
  const [found, setFound] = useState<ModFound[] | null>(null);
  const [checked, setChecked] = useState<ModCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const check = (source: string) =>
    act(async () => {
      setChecked(null);
      setChecked(await api.checkMod(source));
    });
  return (
    <section>
      <h3>Find one</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act(async () => setFound(await api.searchMods(words)));
        }}
      >
        <input
          value={words}
          onChange={(e) => setWords(e.target.value)}
          placeholder="a site or words, or blank for all"
        />{" "}
        <button type="submit" disabled={busy}>
          search npm
        </button>{" "}
        <button type="button" disabled={busy || !words.trim()} onClick={() => check(words.trim())}>
          check this name or folder
        </button>
      </form>
      {found ? (
        found.length ? (
          <table>
            <tbody>
              {found.map((f) => (
                <tr key={f.name}>
                  <td>
                    <strong>{f.name}</strong>@{f.version}
                    <div className="muted">{f.description}</div>
                  </td>
                  <td>
                    {f.sites.join(", ")}
                    <div className="muted">opens {f.domains.join(", ")}</div>
                  </td>
                  <td>
                    {f.code ? (
                      <span className="muted">
                        code: <code>autobrowse mods add {f.name} --trust</code>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => check(`${f.name}@${f.version}`)}
                      >
                        check
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">no mods found</p>
        )
      ) : null}
      {checked ? (
        <div>
          <p>It asks for:</p>
          <pre>{checked.permissions.join("\n")}</pre>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act(async () => {
                await api.addMod(checked.source);
                setChecked(null);
                refresh();
              })
            }
          >
            yes, add it
          </button>{" "}
          <button type="button" disabled={busy} onClick={() => setChecked(null)}>
            no
          </button>
        </div>
      ) : null}
      {busy ? <p className="muted">working…</p> : null}
      {error ? <pre className="error">{error}</pre> : null}
    </section>
  );
}
