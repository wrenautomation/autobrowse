# Sign up and sign in

Login is the profile's job: a session opens signed in through the site's stored
login (`pnpm -s autobrowse login <site>` signs in by itself: password, the
Google button, TOTP, mail or SMS codes). If a wall stays up, say so and stop.

## Before a signup

1. Does the address already have an account? `pnpm -s autobrowse known <site>`
   asks the site's forgot-password page and reads the inbox; nothing changes.
2. The site's own agent path: `/agent-signup.md`, `/.well-known/agent-access.json`,
   `/llms.txt` (`autobrowse read <url>`). Telnyx has one.
3. Which address: the accounts policy's `signup` account unless told otherwise
   (accounts.md). Wren's accounts sign up on Wren's addresses.

## The signup agent

```sh
pnpm -s autobrowse signup <site> --email <address> --name "…" --handle <handle> [--headed]
```

The password is minted and stored first, then an agent fills the form placing
email, password, code and phone by name; it never sees them. `--by-hand` for a
page with a bot check: William's browser, password on the clipboard.

## By hand in explore: secrets by name

`place` types a secret only when the session was opened with the flag that
gives it (flags go after the port in `start.sh`):

| Secret | Flag |
|---|---|
| `email`, `password`, `phone` (E.164), `phoneLocal` (no country code), `code` | `--signup <address>` |
| `code` (newest code that inbox got) | `--codes <inbox>` |
| `password` | `--new-password <address>` |
| `<site>.username`, `.password`, `.code`, `.phone`, `.phoneLocal` | `--login <site>[,<site>…]` |
| `card.number`, `.exp`, `.expMonth`, `.expYear`, `.cvc`, `.name`, `.postal` (`card@<label>.…`) | none: payment-gated |

A missing secret's error names the flag.

Phone: a separate country picker → pick the country, then `phoneLocal`. One box
that reads the country from the digits (a flag changes as you type) → `phone`;
the local number there is read as another country.

A key or token the site shows after signup: `keep` it (explore.md).
