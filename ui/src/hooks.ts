/** Small hooks: hash routing, a loader with refresh, the live event feed. */
import { useCallback, useEffect, useState } from "react";
import { type RunEvent, subscribe } from "./api.js";

/** `#/runs/domain/x.com` → ["runs", "domain", "x.com"]. */
const parseHash = () =>
  location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);

export function useRoute(): string[] {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join("/")}`;

export function useLoad<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's cache key
  useEffect(() => {
    let live = true;
    load().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** Every event since the page opened, newest first; `onEvent` for side effects like reloading. */
export function useEvents(onEvent?: (e: RunEvent) => void): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([]);
  useEffect(
    () =>
      subscribe((e) => {
        setEvents((prev) => [e, ...prev].slice(0, 200));
        onEvent?.(e);
      }),
    [onEvent],
  );
  return events;
}
