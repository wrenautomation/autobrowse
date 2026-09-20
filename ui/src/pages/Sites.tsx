/**
 * Sites: each service autobrowse serves under its official API's shape.
 * Per route, how it answers right now (API, browser, or nothing yet and
 * why); per setup step, run it here (a job) or see what blocks it. A
 * scratch call box sends one official request and shows the answer.
 */
import { useState } from "react";
import { api, type SiteRow } from "../api.js";
import { useLoad } from "../hooks.js";

export function SitesPage() {
  const [version, setVersion] = useState(0);
  const sites = useLoad(() => api.sites(), [version]);
  if (sites.error) return <p className="error">{sites.error}</p>;
  if (!sites.data) return <p>loading…</p>;
  return (
    <>
      <h2>Sites</h2>
      <p className="muted">
        A service under its own API's shape: <code>POST /api/sites/linkedin/rest/posts</code> is
        LinkedIn's Posts API. The API answers when a token is in hand, a browser flow otherwise.
      </p>
      {sites.data.map((s) => (
        <Site key={s.site} site={s} refresh={() => setVersion((v) => v + 1)} />
      ))}
    </>
  );
}

function Site({ site: s, refresh }: { site: SiteRow; refresh: () => void }) {
  return (
    <section>
      <h3>
        {s.site} <span className="muted">{s.origin}</span>{" "}
        <span className={`pill ${s.authed ? "done" : "waiting"}`}>
          {s.authed ? "token ok" : "no token"}
        </span>
      </h3>
      <table>
        <thead>
          <tr>
            <th>route</th>
            <th>answers via</th>
            <th>what</th>
          </tr>
        </thead>
        <tbody>
          {s.routes.map((r) => (
            <tr key={`${r.method} ${r.path}`}>
              <td>
                <code>
                  {r.method} {r.path}
                </code>
                {r.irreversible ? <span className="pill failed"> irreversible</span> : null}
              </td>
              <td>
                <span className={`pill ${r.via === "none" ? "waiting" : "done"}`}>{r.via}</span>
              </td>
              <td className={r.missing ? "muted" : ""}>{r.missing ?? r.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>setup</h4>
      <ul>
        {s.setup.map((st) => (
          <li key={st.name}>
            <SetupStep site={s.site} step={st} refresh={refresh} />
          </li>
        ))}
      </ul>
      <CallBox site={s.site} />
    </section>
  );
}

function SetupStep({
  site,
  step: st,
  refresh,
}: {
  site: string;
  step: SiteRow["setup"][number];
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.siteSetup(site, st.name);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const state = st.done
    ? "done"
    : st.blockedOn.length
      ? `blocked on ${st.blockedOn.join(", ")}`
      : st.unrecorded
        ? `flow ${st.unrecorded} not recorded: explore it first`
        : "ready";
  return (
    <>
      <strong>{st.name}</strong> → {st.makes.join(", ")}{" "}
      <span className={`pill ${st.done ? "done" : "waiting"}`}>{state}</span>{" "}
      {!st.done && !st.blockedOn.length && !st.unrecorded ? (
        <button type="button" disabled={busy} onClick={run}>
          {busy ? "running…" : "run"}
        </button>
      ) : null}
      <div className="muted">{st.summary}</div>
      {err ? <div className="error">{err}</div> : null}
    </>
  );
}

function CallBox({ site }: { site: string }) {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("");
  const [body, setBody] = useState("{}");
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const input = method === "GET" || method === "DELETE" ? undefined : JSON.parse(body);
      setOut(JSON.stringify(await api.siteCall(site, method, path, input), null, 2));
    } catch (e) {
      setOut(`error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>call it</summary>
      <div className="row">
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {["GET", "POST", "PUT", "DELETE"].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <input
          value={path}
          placeholder="/rest/posts?q=author&author=urn:li:person:…"
          onChange={(e) => setPath(e.target.value)}
        />
        <button type="button" disabled={busy || !path} onClick={send}>
          {busy ? "sending…" : "send"}
        </button>
      </div>
      {method !== "GET" && method !== "DELETE" ? (
        <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
      ) : null}
      {out !== null ? <pre>{out}</pre> : null}
    </details>
  );
}
