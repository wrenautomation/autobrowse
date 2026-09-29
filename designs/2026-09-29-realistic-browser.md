# A realistic browser for X, LinkedIn and Cloudflare

2026-09-29. Status: built. Box runs headed Google Chrome; proxy seam hardened.
Open: an IP that is not a datacenter's (William's spend or hardware).

## Ask

William: a VM with real Chrome, not headless Playwright on his Mac, that gets
past X, LinkedIn and Cloudflare checks consistently. And the proxy setup.

## Measure first

`autobrowse fingerprint [profile] [--box]` reads what a site reads: the IP's
network and zone, UA and client hints, WebGL renderer, codecs, plugins,
WebRTC, window frame. It lists the tells; exit 1 when there are any.

| Where | Tells |
|---|---|
| Mac, Google Chrome (headless or headed) | none |
| Mac, bundled Chromium headless | software WebGL, no plugins, no frame, full version in UA |
| Box before (Chromium headless) | never ran: `/data` was uid 1000, pwuser is 1001 (EACCES) |
| Box now (headed Chrome on Xvfb) | software WebGL, datacenter IP |

## Built

- The box is the VM. Its image carries Google Chrome (amd64) and starts Xvfb;
  compose runs it headed in `America/New_York`.
- WebGL: headed Chrome without a GPU has none; `--enable-unsafe-swiftshader`
  turns on the software one (Linux only).
- Proxy seam: a proxied launch blocks non-proxied WebRTC UDP (the leak showed
  the real IP) and runs Chrome in `BROWSER_PROXY_TIMEZONE`, so the clock
  matches the IP.
- The deploy gives `/data` to the image's pwuser by uid, whatever it is.

## What is left, and why it is not code

- **IP.** The biggest signal. An Amazon IP is flagged on sight by X, LinkedIn
  and Cloudflare. Fix: a static ISP proxy (~$3-5/mo, HTTP with login) for
  `x,linkedin` only. His spend.
- **GPU.** Software WebGL says "VM". Cloud GPUs cost ~$400+/mo. Not worth it.

Strongest option: a small always-on machine at home (a used mini PC or old
laptop, ~$150 once). Residential IP, real GPU, real Chrome, no proxy bill. The
worker dials Restate out, so it needs no open port. Same image, `BROWSER=local`.

## Decisions

- D1. Headed Chrome on Xvfb over headless: headless leaves tells Chrome keeps
  adding; headed on a virtual screen has none of its own.
- D2. Linux UA as-is. Faking Windows breaks against fonts, client hints and
  WebGL; a consistent Linux desktop is rarer but coherent.
- D3. No stealth plugins or init-script shims: each patched property is its
  own tell (see `session.ts` on `webdriver`).
- D4. His personal LinkedIn stays on the Mac: a proxy IP is a location change
  on an account with years of history. `linkedin@research` may use the proxy.
