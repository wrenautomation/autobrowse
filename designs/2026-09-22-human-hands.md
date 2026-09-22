# Human hands

Sites watch for bots. They look for clicks dead in the middle of a
control, a pointer that jumps, keys exactly 50ms apart. William asked for
typing that comes in fast and slow runs with pauses, and a mouse that moves
like a hand. He also asked that this kind of robustness live in one
easy-to-find place, behind a simple facade.

## The facade

`src/browser/human/` — one door, `Hands`, with four verbs:

| verb  | what a person does |
|-------|--------------------|
| `think(page)` | pauses to read (350–1600ms, log-uniform); a third of the time the hand drifts meanwhile |
| `click(locator)` | a curved, eased reach to a spot near the middle; a beat of hover; the button held 45–130ms |
| `type(locator \| page, text)` | clears the field, then types in runs: 3–11 keys at one tempo (×0.55–1.9), a beat after punctuation and some words, a rare stall mid-word; doubled letters faster; every key held. Over 400 characters is pasted |
| `press(locator \| page, key)` | one key, held |

`handsFor(pace)` builds it; `handsFor(null)` is instant (tests, demos, a
console). Every caller goes through it: `fp.act` (so every hand-written
flow and every compiled workflow) and the explore socket (so the agent
too). A `Page` in place of a locator means "whatever has focus".

## Behind it

- `typing.ts` — `typingPlan(text, style, random)`: text in, keystrokes with
  hold and gap out. Pure.
- `mouse.ts` — `mousePath`: a cubic Bézier bowed to one side,
  minimum-jerk easing (slow, fast, slow), Fitts's-law duration (farther or
  smaller = longer), overshoot-and-correct on 20% of reaches over 250px,
  sub-pixel jitter, one event per ~14ms. `aimPoint`: normal around the
  centre, clamped to the inner 70%. Pure.
- `draw.ts` — the random draws. Everything takes the random source, so
  tests pass a seeded one and get the same plan back.
- `index.ts` — plays the plans against Playwright. It is the only file
  that touches a page.

**Robustness rule:** the human part only chooses *where* and *when*. The
click itself is still Playwright's `click({position, delay})`, so its
checks (visible, enabled, not covered, inside an iframe) still apply. If the
human part fails (no bounding box, detached element), it falls back to the
plain act. It never turns a working act into a failure. The pointer's
position is remembered per page (Playwright has no getter), in a WeakMap
that dies with the page.

The knobs are `HUMAN_PACE` — one object, every range named. `PACE=fast` in
settings still turns it all off.

## Where to attack, ranked

1. **Scrolling is still programmatic.** `scrollIntoViewIfNeeded` jumps the
   page. A person uses the wheel in uneven bursts. Next: `mouse.wheel` in
   bursts until the box is in view, then the reach.
2. **No typos.** Real typing has errors and backspaces. Left out because
   fields that auto-advance on each character (split OTP boxes) break
   under a backspace. It could be allowed on plain text fields only.
3. **Two flows bypass the facade:** `cloudflare-buy` and `google-dkim` call
   Playwright directly. Move them onto `fp.act`.
4. **Headless is the bigger tell.** npmjs.com's Cloudflare check passes
   headed and stalls headless, whatever the hands do. The fingerprint
   (headless UA, WebGL, fonts) matters more than timing now.
5. **Tuning is guesswork.** The ranges come from typing and
   pointing research, not from William's own hands. The recorder already
   journals his acts. Fitting `HUMAN_PACE` to his real timings would make
   it his hands.
