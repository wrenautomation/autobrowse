# Needs William

Live list: `pnpm autobrowse needs`. Rows clear themselves. Dated 2026-09-27.

## To do

- **TikTok.** In the phone app: sign up → Continue with Google →
  william@wrenautomation.com, name "Wren Automation", handle wrenautomation.
  Then tell me. I do the developer app and consent.

- **Loom plan.** The 14-day trial ends ~10-13. After it, Starter caps at 25
  videos of 5 minutes. Upgrade only if that's too small (your spend).

- **A web search key.** The box can't search: DuckDuckGo bot-checks its IP and
  no key is set. Exa's free signup credits do: copy the key,
  `autobrowse env set EXA_API_KEY --clipboard`.

Optional: `autobrowse creds paste google@will` and a Gmail consent for
will@williamjin.dev, if autobrowse should read that inbox.


Deferred (your call, 09-29: X and LinkedIn run on the Mac's Chrome). Later, if they move to the box: a static ISP proxy
(~$3-5/mo per IP; your spend). The box has a datacenter IP these sites
flag; the Mac's home IP is fine. Buy an HTTP one (Chrome takes no login
on socks5), in one US city. Then copy its URL and run
`autobrowse env set BROWSER_PROXY --clipboard`,
`echo x@wren,linkedin@research | autobrowse env set BROWSER_PROXY_SITES`, and
`echo America/Chicago | autobrowse env set BROWSER_PROXY_TIMEZONE` (the
proxy city's zone). `autobrowse fingerprint x --box` then shows no tells.
