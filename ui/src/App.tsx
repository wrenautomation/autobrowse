import { useCallback, useState } from "react";
import { getToken, type RunEvent, setToken } from "./api.js";
import { href, useEvents, useRoute } from "./hooks.js";
import { AgentPage, ExplorePage } from "./pages/Explore.js";
import { RecordingPage, RecordingsPage } from "./pages/Recordings.js";
import { RunPage } from "./pages/Run.js";
import { RunsPage } from "./pages/Runs.js";

export function App() {
  const route = useRoute();
  const [version, setVersion] = useState(0);
  const bump = useCallback((_e: RunEvent) => setVersion((v) => v + 1), []);
  const events = useEvents(bump);
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
        </nav>
        <span className="spacer" />
        <TokenBox />
      </header>
      <main>
        {page === "runs" && a && b ? (
          <RunPage workflow={a} runKey={b} version={version} />
        ) : page === "recordings" && a ? (
          <RecordingPage name={a} />
        ) : page === "recordings" ? (
          <RecordingsPage />
        ) : page === "explore" && a ? (
          <AgentPage id={a} />
        ) : page === "explore" ? (
          <ExplorePage />
        ) : (
          <RunsPage version={version} />
        )}
      </main>
      <Ticker events={events} />
    </>
  );
}

/** The bearer, when the worker wants one. Stored per browser, sent as a header only. */
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
