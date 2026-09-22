# Secrets and money sandbox

William, 2026-09-22: "build out the first class sandbox for credentials /
touching money / kind of like openclaw but with good security features".

## Shape

OpenClaw and autobrowse are the same kind of thing: a personal agent on your
own machine with channels, memory and skills. The security posture is the
opposite. There, the model holds the keys and runs shell it wrote. Here:

- the model never sees a secret (`place{secret}`, `keep{env}`, sealed store,
  `redactAria`); it names them, the session fills them;
- a secret can only land where it belongs (origin binding, below);
- every use is written down (audit ledger, below);
- money is a person's yes over a channel they answer on (payment gate);
- deterministic compiled workflows replay; the model is only the explorer
  and the repairer;
- the explore socket is loopback + bearer; no marketplace, no plugin code.

## Decisions

1a. **Compiled runs are bound too** (2026-09-22). `compiledDeps` wraps the
   worker's `secrets` in `trackingSecrets` (remembers every value it hands
   out, by key) and the browser in `boundRunner`: a `fill` whose value came
   from `secrets` is checked against `siteAllowsHost(flow.site, host)` —
   the flow's site as a registrable name (`instantly` → `app.instantly.ai`,
   never `instantly-help.evil.example`) or its login origins — refused
   with `SecretLeak` otherwise, and audited under `<site>/<flow>` as
   `field: "secret"`. The renderer did not change: whatever a workflow was
   compiled from, its secrets are bound at run time. `boundPage` is the one
   primitive; `guardedPage` (sign-in) is now built on it.

6a. **Canaries** (2026-09-22, credvault `canary`, was `src/auth/canary.ts`). `creds canary stripe`
   stores a real-looking credential (random password, `canary: true`)
   under a name a thief or a confused model reaches for. Nothing in the
   product asks for it, so a `get` IS the incident: `canaryStore` (which
   `credentialsFor` always returns, except the operator's own `creds
   list`) writes a `… (canary)` refused line to the ledger, tells a person
   over the channels when sign-in is the caller, and throws
   `CanaryTripped`. Its password is also refused on every host by
   `guardedPage`, so a copy that leaked some other way types nowhere.

1. **Origin binding** (`src/auth/guard.ts`, done). A password only types on
   a host under its site's domains: the site's `home` registrable domain,
   `SiteLogin.origins` (google → `google.com`; microsoft → `live.com`,
   `microsoftonline.com`, `microsoft.com`), and the credential's own `url`.
   `guardedPage` wraps the page each sign-in sees: a `fill` whose value is
   the password or the previous password on any other host throws
   `SecretLeak` before a keystroke. With no domains known, the host must
   carry the credential's name. A placed signup secret (`place`) is bound
   the same way: hosts carrying the site's name or the `--url` host
   (`signupHosts`). A phishing redirect, a look-alike, or a model told to
   "paste the password here" all hit the same wall.
2. **Audit ledger** (done). `~/.config/autobrowse/audit.jsonl` (0600, next
   to the credential file): one line per secret use — when, which
   credential and field, site, URL without query, who (`login`, `place
   <name>`), allowed or refused. Never the value. `autobrowse creds audit
   --last 50` reads it. Every login provider and explore session writes to
   it (`auditFor(settings)`).
3. **Spend policy** (`src/gates/spend.ts`, done). The gate still asks;
   policy decides what it may say yes to alone and what it refuses before
   anyone is asked. `amountIn` reads the money on the element that spends
   ("Buy $20 of credits" → 20 USD) into the ask; `SPEND_ALLOW` (sites),
   `SPEND_AUTO_YES_UNDER`, `SPEND_DAILY_CAP`, `SPEND_HARD_CAP`. Default:
   every ask goes to the person, no ceiling. A button with no amount on it
   is always a question. Every decision (auto, person, denied, cap) is a
   line in `spend.jsonl` beside the audit; `autobrowse spend` reads it.
   The amount is read from the element, not the page: a "$20" input next
   to a plain "Buy" button is an unknown amount, so the person is asked.
4. **Virtual cards** (William's vendor choice). One card per site with its
   own limit, so the blast radius of any one session is that card's cap.
   Card numbers are secrets like passwords: placed, never seen, origin
   bound to the merchant.
5. **Process isolation** (mostly exists). Box = its own EC2 instance with
   SSM-scoped env; laptop = sealed keychain-keyed store; explore socket
   loopback + bearer; root through one logged helper.
6. **Canaries** (later). A credential that exists only to be tripped: any
   use of it anywhere means the store or the model path leaked.

## Where to attack

1. ✅ Amount from the page when the button has none: `amountNear` reads the closest
   block around the button that says "total" and takes its last total line
   (`totalIn`; subtotals ignored). Nothing found = a question with no amount, as before.
2. Virtual cards (4) once the vendor is chosen.
3. ✅ The box sends its ledger summary (`src/auth/ledger.ts`) over the channel right
   before its idle stop, and serves `GET /api/ledger?since=`. Still local-only:
   `creds audit`/`spend` read the disk they run on.
