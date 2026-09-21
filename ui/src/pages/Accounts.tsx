/**
 * Accounts: the stored sign-ins, one row per site (never a value, only
 * what is there). Add or change one in place; "check" signs in headless
 * with what is stored and says so. What the terminal's `creds set` and
 * `login` do, without a terminal.
 */
import { useState } from "react";
import type { AccountEdit, AccountRow } from "../../../src/auth/accounts.js";
import { type AccountReadiness, api } from "../api.js";
import { useLoad } from "../hooks.js";

const PROVIDERS = ["", "google", "github", "microsoft"] as const;

export function AccountsPage() {
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const rows = useLoad(() => api.accounts(), [version]);
  const refresh = () => setVersion((v) => v + 1);
  if (rows.error) return <p className="error">{rows.error}</p>;
  if (!rows.data) return <p>loading…</p>;
  return (
    <>
      <Policy />
      <h2>Sign-ins</h2>
      <p className="muted">
        One sign-in per site, kept sealed on this machine. Values never come back here; the marks
        say what is stored. "check" signs in headless with it.
      </p>
      <table>
        <thead>
          <tr>
            <th>site</th>
            <th>username</th>
            <th>stored</th>
            <th>via</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.data.map((r) => (
            <Account key={r.site} row={r} refresh={refresh} />
          ))}
        </tbody>
      </table>
      {adding ? (
        <AccountForm
          site=""
          row={null}
          onDone={() => {
            setAdding(false);
            refresh();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)}>
          add a site
        </button>
      )}
    </>
  );
}

function marks(r: AccountRow): string {
  const m: string[] = [];
  if (r.has.password) m.push("password");
  if (r.has.totpSecret) m.push("authenticator");
  if (r.has.passkeys) m.push("passkey");
  if (r.has.recoveryCodes) m.push("recovery codes");
  if (r.has.codesInbox) m.push("codes inbox");
  return m.join(", ") || "—";
}

function Account({ row: r, refresh }: { row: AccountRow; refresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const check = async () => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ ok: true, text: await api.checkAccount(r.site) });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const stored = r.username !== null;
  return (
    <>
      <tr>
        <td>
          <strong>{r.site}</strong>
          {r.known ? null : <span className="muted"> (provider sign-in only)</span>}
          {r.ask ? <div className="muted">{r.ask}</div> : null}
        </td>
        <td>{r.username ?? <span className="muted">not stored</span>}</td>
        <td>{marks(r)}</td>
        <td>{r.via ?? "—"}</td>
        <td>
          <button type="button" onClick={() => setEditing((e) => !e)}>
            {editing ? "close" : stored ? "change" : "add"}
          </button>{" "}
          {stored ? (
            <button type="button" disabled={busy} onClick={check}>
              {busy ? "signing in…" : "check"}
            </button>
          ) : null}
          {note ? <div className={note.ok ? "muted" : "error"}>{note.text}</div> : null}
        </td>
      </tr>
      {editing ? (
        <tr>
          <td colSpan={5}>
            <AccountForm
              site={r.site}
              row={r}
              onDone={() => {
                setEditing(false);
                refresh();
              }}
              onCancel={() => setEditing(false)}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** Blank fields keep what is stored; a via provider replaces the password path. */
function AccountForm({
  site: initial,
  row,
  onDone,
  onCancel,
}: {
  site: string;
  row: AccountRow | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [site, setSite] = useState(initial);
  const [edit, setEdit] = useState<AccountEdit>({
    username: row?.username ?? "",
    password: "",
    totpSecret: "",
    via: (row?.via as AccountEdit["via"]) ?? "",
    url: row?.url ?? "",
    codesInbox: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set =
    (k: keyof AccountEdit) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setEdit((s) => ({ ...s, [k]: e.target.value }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.saveAccount(site.trim(), edit);
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const keep = row ? " (blank keeps what is stored)" : "";
  const id = (k: string) => `acct-${row?.site ?? "new"}-${k}`;
  return (
    <form className="card" onSubmit={save} autoComplete="off">
      {row ? null : (
        <div className="field">
          <label htmlFor={id("site")}>site</label>
          <input
            id={id("site")}
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="new-tool"
            required
          />
        </div>
      )}
      <div className="field">
        <label htmlFor={id("username")}>username / email</label>
        <input
          id={id("username")}
          value={edit.username}
          onChange={set("username")}
          required={!row}
        />
      </div>
      <div className="field">
        <label htmlFor={id("password")}>password{keep}</label>
        <input
          id={id("password")}
          type="password"
          value={edit.password}
          onChange={set("password")}
        />
      </div>
      <div className="field">
        <label htmlFor={id("totp")}>
          authenticator key (the base32 seed, not a 6-digit code){keep}
        </label>
        <input
          id={id("totp")}
          type="password"
          value={edit.totpSecret}
          onChange={set("totpSecret")}
        />
      </div>
      <div className="field">
        <label htmlFor={id("via")}>sign in via</label>
        <select id={id("via")} value={edit.via} onChange={set("via")}>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p || "its own password"}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={id("url")}>login page (for a site with no spec here)</label>
        <input
          id={id("url")}
          value={edit.url}
          onChange={set("url")}
          placeholder="https://new-tool.test/login"
        />
      </div>
      <div className="field">
        <label htmlFor={id("inbox")}>
          codes inbox (where the site emails codes, when not the username)
        </label>
        <input id={id("inbox")} value={edit.codesInbox} onChange={set("codesInbox")} />
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "saving…" : "save"}
        </button>
        <button type="button" onClick={onCancel}>
          cancel
        </button>
      </div>
      {err ? <div className="error">{err}</div> : null}
    </form>
  );
}

/**
 * Which of the person's accounts is for what (pays, default, signup) and
 * how ready each is: a stored credential, a readable inbox, kept tokens.
 * Every signup, consent and provider sign-in reads this when nothing
 * names an account.
 */
function Policy() {
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rows = useLoad(() => api.policy(), [version]);
  const use = async (purpose: string, address: string) => {
    setError(null);
    try {
      await api.assignPolicy(purpose, address);
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const purposes = rows.data?.purposes ?? {};
  return (
    <>
      <h2>Which account for what</h2>
      <p className="muted">
        {Object.entries(purposes)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · ")}
        . Pick who holds each purpose; it moves from whoever had it.
      </p>
      {rows.error ? <p className="error">{rows.error}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      {rows.data ? (
        rows.data.accounts.length ? (
          <table>
            <thead>
              <tr>
                <th>account</th>
                <th>at</th>
                <th>for</th>
                <th>credential</th>
                <th>inbox</th>
                <th>tokens</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.data.accounts.map((r) => (
                <PolicyRow key={r.address} row={r} use={use} purposes={Object.keys(purposes)} />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">
            no accounts yet:{" "}
            <code>autobrowse accounts add &lt;address&gt; --for pays|default|signup</code>
          </p>
        )
      ) : (
        <p>loading…</p>
      )}
    </>
  );
}

function PolicyRow({
  row: r,
  use,
  purposes,
}: {
  row: AccountReadiness;
  use: (purpose: string, address: string) => Promise<void>;
  purposes: string[];
}) {
  const missing = purposes.filter((p) => !r.for.includes(p));
  return (
    <tr>
      <td>
        <strong>{r.address}</strong>
      </td>
      <td>{r.at}</td>
      <td>{r.for.join(", ") || "—"}</td>
      <td>{r.credential ?? <span className="muted">none (creds paste)</span>}</td>
      <td>{r.inbox ? `via ${r.inbox}` : <span className="muted">not readable</span>}</td>
      <td>{r.tokens.join(", ") || "—"}</td>
      <td>
        {missing.length ? (
          <select value="" onChange={(e) => e.target.value && void use(e.target.value, r.address)}>
            <option value="">use for…</option>
            {missing.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : null}
      </td>
    </tr>
  );
}
