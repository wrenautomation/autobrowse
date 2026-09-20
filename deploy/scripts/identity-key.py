#!/usr/bin/env python3
"""Print the Restate Cloud environment's request-identity public key (publickeyv1_…).

Reads the CLI's session from ~/.config/restate/config.toml (run `restate cloud login`
first; the session lasts a day). Only the public key is printed. Paste it into
deploy/prod.env as RESTATE_IDENTITY_KEY, or: identity-key.py >> prod.env with the
--env flag.
"""
import base64, json, os, re, sys, time, urllib.request

cfg = os.path.expanduser("~/.config/restate/config.toml")
acct = env_id = jwt = None
for line in open(cfg):
    for name in ("account_id", "environment_id", "access_token"):
        m = re.match(rf'\s*{name}\s*=\s*"?([^"\s]+)', line)
        if m:
            if name == "account_id": acct = m.group(1)
            if name == "environment_id": env_id = m.group(1)
            if name == "access_token": jwt = m.group(1)
if not (acct and env_id and jwt):
    sys.exit("restate cloud env configure + restate cloud login first")
exp = json.loads(base64.urlsafe_b64decode(jwt.split(".")[1] + "==")).get("exp", 0)
if exp < time.time():
    sys.exit("cloud session expired: restate cloud login, then rerun")
req = urllib.request.Request(
    f"https://api.us.restate.cloud/cloud/{acct}/DescribeEnvironment",
    method="POST",
    headers={"authorization": f"Bearer {jwt}", "content-type": "application/json"},
    data=json.dumps({"environmentId": env_id}).encode(),
)
body = json.load(urllib.request.urlopen(req, timeout=20))

def find(o):
    if isinstance(o, dict):
        for v in o.values():
            if isinstance(v, str) and v.startswith("publickeyv1_"): return v
            r = find(v)
            if r: return r
    if isinstance(o, list):
        for v in o:
            r = find(v)
            if r: return r
key = find(body)
if not key:
    sys.exit(f"no publickeyv1_ in the answer; fields: {sorted(body)}")
print(f"RESTATE_IDENTITY_KEY={key}" if "--env" in sys.argv else key)
