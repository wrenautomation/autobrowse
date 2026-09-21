import { useCallback, useState } from "react";
import { api, getToken, type RunEvent, setToken } from "./api.js";
import { href, useEvents, useLoad, useRoute } from "./hooks.js";
import { AccountsPage } from "./pages/Accounts.js";
import { AgentPage, ExplorePage } from "./pages/Explore.js";
import { RecordingPage, RecordingsPage } from "./pages/Recordings.js";
import { RunPage } from "./pages/Run.js";
import { RunsPage } from "./pages/Runs.js";
import { SitesPage } from "./pages/Sites.js";
import { StatusPage } from "./pages/Status.js";
import { WorkflowPage } from "./pages/Workflow.js";

export function App() {
  const route = useRoute();
  const [event, setEvent] = useState<RunEvent | null>(null);
  const onEvent = useCallback((e: RunEvent) => setEvent(e), []);
  const events = useEvents(onEvent);
  const [page, a, b] = route;
  const nav = (name: string, label: string) => (
    <a href={href(name)} className={(page ?? "runs") === name ? "active" : ""}>
      {label}
    </a>
  );
  return (
    <>
      <header>
        <span className="brand">autobrowse</span>
        <nav>
          {nav("runs", "Runs")}
          {nav("recordings", "Recordings")}
          {nav("explore", "Explore")}
          {nav("sites", "Sites")}
          {nav("accounts", "Accounts")}
          {nav("status", "Status")}
        </nav>
        <span className="spacer" />
        <ScreenToggle />
        <TokenBox />
      </header>
      <main>
        {page === "runs" && a && b ? (
          <RunPage workflow={a} runKey={b} event={event} />
        ) : page === "workflows" && a ? (
          <WorkflowPage name={a} />
        ) : page === "recordings" && a ? (
          <RecordingPage name={a} />
        ) : page === "recordings" ? (
          <RecordingsPage />
        ) : page === "explore" && a ? (
          <AgentPage id={a} />
        ) : page === "explore" ? (
          <ExplorePage />
        ) : page === "sites" ? (
          <SitesPage />
        ) : page === "accounts" ? (
          <AccountsPage />
        ) : page === "status" ? (
          <StatusPage />
        ) : (
          <RunsPage event={event} />
        )}
      </main>
      <Ticker events={events} />
    </>
  );
}

/** The bearer, when the worker wants one. Stored per browser, sent as a header only. */
/** Headed or headless for every browser the worker opens next: one click, no reload. */
function ScreenToggle() {
  const live = useLoad(() => api.settings(), []);
  const [busy, setBusy] = useState(false);
  const s = live.data;
  if (!s) return null;
  const flip = async () => {
    setBusy(true);
    try {
      await api.putSettings({ headless: !s.headless });
      live.reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="mono"
      onClick={flip}
      disabled={busy}
      title="Applies to the next browser that opens; one already open keeps its mode"
    >
      {s.headless ? "headless" : "headed"}
    </button>
  );
}

function TokenBox() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(getToken());
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="mono">
        {getToken() ? "token set" : "no token"}
      </button>
    );
  return (
    <span className="row">
      <input
        type="password"
        value={value}
        placeholder="UI_TOKEN"
        onChange={(e) => setValue(e.target.value)}
        style={{ width: 200 }}
      />
      <button
        type="button"
        className="primary"
        onClick={() => {
          setToken(value);
          setOpen(false);
          location.reload();
        }}
      >
        save
      </button>
    </span>
  );
}

const WORDING: Record<RunEvent["type"], string> = {
  started: "started",
  step: "step",
  "gate-opened": "needs you",
  "gate-answered": "gate answered",
  paused: "paused",
  resumed: "playing",
  finished: "finished",
  reset: "reset",
};

function Ticker({ events }: { events: RunEvent[] }) {
  const recent = events.slice(0, 3);
  if (!recent.length) return null;
  return (
    <div className="ticker">
      {recent.map((e) => (
        <div
          className={`card ${e.type === "gate-opened" ? "gate" : ""}`}
          key={`${e.at}-${e.type}-${e.run.workflow}-${e.run.key}`}
        >
          <a href={href("runs", e.run.workflow, e.run.key)}>
            {e.run.workflow}/{e.run.key}
          </a>{" "}
          <span className="muted">{WORDING[e.type]}</span>
          {e.type === "step" ? ` · ${e.step}: ${e.result.status}` : ""}
          {e.type === "gate-opened" ? ` · ${e.gate.prompt}` : ""}
          {e.type === "finished" ? ` · ${e.status}` : ""}
        </div>
      ))}
    </div>
  );
}
