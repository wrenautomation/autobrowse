# Browser identity, frames and the checkbox captcha

LinkedIn's password reset stops at reCAPTCHA Enterprise. The checkbox
never ticked. Four things were wrong, each fixed where it lives. The
password is set now (`linkedin-password` cleared).

## What a site sees: `src/browser/identity.ts`

Nothing about the machine is written down per platform. It is read off
this host's own Chrome.

- **Headed** Chrome is left alone. `viewport: null` plus
  `--window-size=1280,900`. A forced viewport gave `outerHeight` below
  `innerHeight`, a screen the size of the page, and DPR 1 on a Retina Mac.
- **Headless** learns the headed identity once. `learnIdentity` reads the
  UA, the high-entropy client hints, `navigator.platform` and the languages
  on a routed https page (hints need a secure context). Then it relaunches
  wearing that identity:
  - a `--user-agent` flag covers the first requests;
  - `Emulation.setUserAgentOverride` with the full metadata covers every
    page and every cross-site frame.

  Not Playwright's `userAgent` option: that rebuilds the hints from the
  string and sends arch "x86" and OS "10_15_7" from an arm Mac on 26.x.
- **Headless screen and DPR** come from a small per-OS table: a common
  display for that OS.
- **No `navigator.webdriver` shim.** The flag
  `--disable-blink-features=AutomationControlled` already makes it
  `false`. The old init script left an own property on `navigator`
  reading `undefined`, and that is a tell.

## Frames in the outline: `src/browser/frames.ts`

Playwright's aria snapshot stops at an iframe. `ariaWithFrames` appends
each visible frame as `- iframe "<chain>":`, down to depth 3. The chain is
the `frame` hint that finds the element again:
`parent >> internal:control=enter-frame >> child`. The digest tags refs
inside a section with that frame. Explore, the agent and MCP all click
them like any control. The prompts say a checkbox captcha is clicked; an
image or puzzle challenge is for a person.

## The hidden window: `keepOutOfTheWay`

This was the real blocker. A headed window hidden on macOS still renders,
but Chrome stops routing clicks into a cross-site frame nested in another
frame. The parent frame receives them, with target `IFRAME`. On Google's
demo (one level deep) the click worked. On LinkedIn (`captcha-internal` →
Google anchor) nothing reached the anchor.

Now the window stays and only focus goes back. Reproduced and verified
with a local two-host page, headed: hidden → never ticks, kept → ticks.

## Explore can finish a reset

- `explore --codes <inbox>`: `place {secret:"code"}` types the newest code.
- `explore --new-password`: `mintPassword` stores a password on a
  provider-only (`via`) credential before the browser opens.
  - A stalled reset keeps the password it stored.
  - A password the person set is refused (`creds rotate` is theirs).
- `eval` with `hints` runs a function of that element, in its frame.
- `screenshot` fails loudly, never returning a path to a missing file.

LinkedIn route: address → Next → checkbox → code → password twice →
untick "sign out all devices" → Submit. The tail is saved as
`recordings/linkedin-password-reset`.

## Where to attack

1. **One headed session at a time is still headed.** The window now
   stays on screen behind the front app. If that gets in the way, the
   fix is a separate macOS Space or a virtual display, never a hidden
   window.
2. **Headless and nested frames are untested on a real captcha.** The
   local test covers routing, not a risk score. Try LinkedIn headless once
   before trusting a headless reset.
3. **The LinkedIn reset is half recorded.** The session restarted at the
   code page, so the recording starts there. Record it end to end once, and
   use it the next time a password is owed.
4. **Leaked browsers.** Two Chrome processes from earlier sessions
   (langfuse headless, npm) were still running. Nothing reaps a session
   whose owner died.
5. **The per-OS screen table** is the one hardcoded guess. A Linux box
   with an odd display will still claim 1920x1080 @1.
