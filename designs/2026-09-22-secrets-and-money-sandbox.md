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
3. **Spend policy** (next). The payment gate asks; policy decides what it
   may say yes to on its own and what it must refuse outright: a per-site
   and per-day cap, a merchant allowlist, the amount in the ask when the
   page shows one, auto-yes under a small cap, hard refuse over a ceiling.
   Purchases land in the same ledger.
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

1. Spend policy (3): caps and allowlist on `paymentGate` + the amount read
   from the page into the ask.
2. Bind the compiled runs too: `flowRunner` fills through `guardedPage`
   for every `{from:"secret"}` op, not only sign-in.
3. Canaries (6): one fake credential in the store, an alert in the ledger.
4. Virtual cards (4) once the vendor is chosen.
5. `creds audit` on the box: the ledger lives on its disk; ship it to the
   channel daily or read it over `sites`.
