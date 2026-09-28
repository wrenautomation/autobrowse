# Own browser: sites that need yours

2026-09-27. Status: built for Chromium browsers. Safari: refused with a reason.

## Ask

William: GitHub's "Continue with Google" works in his own browser and fails
in ours. Use his actual browser for GitHub. Chrome by default; Safari too.

## Built

- `OWN_BROWSER_SITES=github` opts a site in. `OWN_BROWSER` picks the
  browser: `chrome` (default), `opera-gx`, `opera`, `brave`, `edge`, or a
  data dir.
- Attach, never launch: Chromium 144+ has "Allow remote debugging" at
  `chrome://inspect/#remote-debugging`. It writes `DevToolsActivePort`; we
  connect over CDP. The browser asks the person to allow each connection
  (we wait 120s).
- We work in a new tab and close only it. No trace, no passkey stand-in,
  nothing context-wide.

## GitHub (09-27)

The own browser worked, but each connect asks for a click. GitHub now signs
in headless with its password instead (one account, password first, Google
second: `methodsOf`). Two-factor: authenticator key, else text or email code,
never GitHub Mobile. `OWN_BROWSER_SITES` is empty again.

## Safari

No path that keeps his logins and passes a sign-in page:

- No CDP. Web Inspector's protocol is private.
- `safaridriver` windows are isolated: fresh cookies, signed out.
- Apple Events `do JavaScript` runs in his tab, but its clicks are synthetic
  (`isTrusted: false`). Sign-in pages check for that.
- Copying Safari's cookies into WebKit: his sessions leave the browser.
  Not doing that.

`OWN_BROWSER=safari` fails with that reason.

If Safari is ever needed: macOS Accessibility (`AXPress` on the page's
elements) gives real clicks without screen coordinates. It is a new driver
under `Hands`, not a Playwright page, so flows would need a second backend.
Weeks of work, not worth it while Chrome works.

## Where to attack

1. Any page of his may be open in the same browser. We only touch our tab,
   but a flow could navigate it anywhere. Keep the list to sites he named.
2. The Allow prompt comes every connect. Fine for rare work (login), bad for
   loops. Don't put a looping site here.
3. His extensions run in our tab (password managers, ad blockers). A flow
   may see extra UI.
