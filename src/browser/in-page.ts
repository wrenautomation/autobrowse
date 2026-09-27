/**
 * Evaluate in the page's own world: its globals, its handlers, the bindings
 * `exposeBinding` put there. Patchright evaluates in an isolated world by
 * default (a page cannot see it), which is right for reading the DOM and
 * wrong for a shim the page must call (a clipboard catch) or a script that
 * talks to a binding (the recorder's observer). Plain Playwright ignores the
 * extra argument and is always in the page's world.
 */
import type { Page } from "playwright";

type Evaluate = (
  fn: unknown,
  arg: unknown,
  options: undefined,
  isolated: boolean,
) => Promise<unknown>;

export function inPage<R, A = undefined>(
  page: Page,
  fn: string | ((arg: A) => R | Promise<R>),
  arg?: A,
): Promise<R> {
  return (page.evaluate as unknown as Evaluate).call(page, fn, arg, undefined, false) as Promise<R>;
}
