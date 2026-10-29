/**
 * A shot of the page as the site drew it: anything we draw over a page (the
 * overlay) registers here and steps off while `fn` runs. Nothing registered:
 * `fn` runs as is.
 */
import type { Page } from "playwright";

type Off = <T>(fn: () => Promise<T>) => Promise<T>;

const offs = new WeakMap<Page, Off>();

/** What draws on `page` says how to take itself off; null forgets it. */
export function drawsOn(page: Page, off: Off | null): void {
  if (off) offs.set(page, off);
  else offs.delete(page);
}

/** Runs `fn` (a screenshot) with nothing of ours over the page. */
export function bare<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  const off = offs.get(page);
  return off ? off(fn) : fn();
}
