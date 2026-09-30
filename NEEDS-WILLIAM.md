# Needs William

Live list: `pnpm autobrowse needs`. Rows clear themselves. Dated 2026-09-30.

## To do

- **Gmail on your personal account: optional.** This is the permission to
  read that inbox (an OAuth token), not the browser login. It was made while
  the Google app was in Testing, and Testing tokens die after 7 days. The app
  is published now, so a new token lasts. I won't redo it: Google asks
  "verify it's you" before Gmail access, and the flow would type the stored
  personal password, the one Google rejects. If you want that inbox read:
  copy your current password, then run `autobrowse creds paste google` and
  `autobrowse site setup gmail consent --account <your gmail>`.

- **Heads-up, no action.** TikTok is live through a sandbox app: posts stay
  private until TikTok reviews the app, and the review needs a demo video.
  Say when you want public TikTok posts; I make the video and apply.

- **Loom plan.** The 14-day trial ends ~10-13. After it, Starter caps at 25
  videos of 5 minutes. Upgrade only if that's too small (your spend).

- **Heads-up, no action.** 09-29 a Perplexity sign-in fell back to your
  personal Google credential and typed its stored password once. Google
  rejected it. Fixed: a site made through Google now always signs in as its
  own account. If Google mails you about a failed sign-in, that was it.

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
