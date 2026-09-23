/** `autobrowse login <site>` and `autobrowse record <name>`: the recorder's command line. */
import { join } from "node:path";
import type { Command } from "commander";
import type { SecretValues } from "../auth/signup.js";
import { explorerOpener, type LocalBackend } from "./backend.js";
import type { Settings } from "./config.js";
import { headed } from "./screen.js";
import { browserOptions, COMPILED_DIR, llmFor } from "./services.js";

/** Long enough to fill a signup form; `creds copy` puts it back after. */
const HAND_CLIPBOARD_MS = 5 * 60_000;
/** How long a signup by hand may take before the wait gives up. */
const HAND_WAIT_MS = 30 * 60_000;

export function registerRecordCommands(
  program: Command,
  settings: Settings,
  local: LocalBackend,
): void {
  /** Headless as the env says unless the person asks to watch. */
  const opener = (o: { headed?: boolean }) =>
    explorerOpener(settings, undefined, o.headed ? headed : undefined);
  program
    .command("explore <site>")
    .description(
      "Keep one browser open on the site and take commands over loopback (POST JSON to /); every act that works is journaled; `save` writes a recording",
    )
    .option("--url <url>", "start here")
    .option("--port <port>", "loopback port", "9090")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .option("--idle <minutes>", "close after this long with no command; 0 = never", "30")
    .option(
      "--codes <inbox>",
      'place{secret:"code"} types the newest code this inbox got after the session opened',
    )
    .option(
      "--signup <address>",
      "a new account made by hand here: the stored (or minted) credential for that address, our phone and --codes are what place types",
    )
    .option(
      "--new-password <address>",
      'give that account (its stored credential, `site` or `site@<label>`) a password of its own, stored before the browser opens; place{secret:"password"} types it',
    )
    .action(
      async (
        site: string,
        o: {
          url?: string;
          port: string;
          headed?: boolean;
          idle: string;
          codes?: string;
          newPassword?: string;
          signup?: string;
        },
      ) => {
        const { tokenFileFor } = await import("../explore/server.js");
        const tokenFile = tokenFileFor(Number(o.port));
        const ex = await opener(o)(site, Number(o.port), {
          tokenFile,
          idleMinutes: Number(o.idle),
          signIn: !o.signup,
          ...(await exploreSecrets(site, o)),
        });
        // The token lives in an owner-only file, not in this output: logs get pasted, files do not.
        console.log(
          `exploring ${site} on http://127.0.0.1:${ex.port}\ntoken file ${tokenFile}\ncurl -s -X POST -H "Authorization: Bearer $(cat ${tokenFile})" http://127.0.0.1:${ex.port}/ -d '{"cmd":"aria"}'`,
        );
        if (o.url)
          await fetch(`http://127.0.0.1:${ex.port}/`, {
            method: "POST",
            headers: { authorization: `Bearer ${ex.token}` },
            body: JSON.stringify({ cmd: "open", url: o.url }),
          });
        await ex.done;
        console.log(`explore ${site} closed`);
      },
    );

  /** What `place` may type in an explore session: codes from an inbox, a minted password. */
  const exploreSecrets = async (
    site: string,
    o: { url?: string; codes?: string; newPassword?: string; signup?: string },
  ): Promise<{ secrets?: SecretValues; secretHosts?: (host: string) => boolean }> => {
    if (!o.codes && !o.newPassword && !o.signup) return {};
    const { codeSecrets, mintCredential, mintPassword, signupHosts, signupSecrets } = await import(
      "../auth/signup.js"
    );
    const { codesFor, credentialsFor, gmailFor, ourPhone } = await import("./services.js");
    if (o.signup) {
      // A stalled attempt at the same address keeps its password: never a second one.
      const inbox = await readableInbox(o.codes ?? o.signup);
      const cred = await mintCredential(credentialsFor(settings), {
        site,
        email: o.signup,
        inbox,
      });
      return {
        secrets: signupSecrets({
          cred,
          codes: codesFor(settings, gmailFor(settings)),
          since: new Date(),
          phone: ourPhone(settings),
        }),
        secretHosts: signupHosts(site, o.url ?? null),
      };
    }
    const code = o.codes
      ? codeSecrets(
          codesFor(settings, gmailFor(settings)),
          await readableInbox(o.codes),
          new Date(),
        )
      : null;
    const cred = o.newPassword
      ? (await mintPassword(credentialsFor(settings), site, o.newPassword)).cred
      : null;
    return {
      secrets: async (name) => {
        if (name === "code") return code ? code(name) : null;
        if (name === "password") return cred?.password ?? null;
        if (name === "email") return cred?.username ?? null;
        return null;
      },
      secretHosts: signupHosts(site, o.url ?? null),
    };
  };

  /** An inbox this system reads codes from, or why not. */
  const readableInbox = async (inbox: string): Promise<string> => {
    const { signupInbox } = await import("../auth/signup.js");
    const ok = signupInbox(inbox, {
      env: (n) => process.env[n],
      workspaceDomain: settings.googleWorkspaceDomain ?? null,
    });
    if (!ok) throw new Error(`${inbox}'s inbox is not readable (autobrowse accounts)`);
    return inbox;
  };

  program
    .command("mcp")
    .description(
      "Serve autobrowse as MCP tools over stdio for Claude Code: `claude mcp add autobrowse -- pnpm autobrowse mcp`",
    )
    .option("--port <port>", "first loopback port for sessions", "9300")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .action(async (o: { port: string; headed?: boolean }) => {
      const open = opener(o);
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { buildMcpServer } = await import("../mcp/server.js");
      const { version } = JSON.parse(
        await import("node:fs").then((fs) =>
          fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ),
      ) as { version: string };
      let port = Number(o.port);
      const server = buildMcpServer({
        version,
        open: async (site, url) => {
          const ex = await open(site, port++);
          if (url) await ex.exec({ cmd: "open", url });
          return ex;
        },
        do: (req) => local().backend.do.do(req),
      });
      // stdout is the protocol: anything else goes to stderr.
      console.log = (...a: unknown[]) => console.error(...a);
      await server.connect(new StdioServerTransport());
    });

  program
    .command("record <name>")
    .description(
      "Record a chore: a headed browser with an observer, play/pause from this terminal, optional terminal capture",
    )
    .option("--site <site>", "use this site's logged-in profile", "scratch")
    .option("--url <url>", "start here")
    .option("--terminal", "also record a shell session in this terminal after the browser closes")
    .action(async (name: string, o: { site: string; url?: string; terminal?: boolean }) => {
      const { recordChore } = await import("../recorder/index.js");
      const opts = browserOptions(settings, headed); // a person records: they need to see it
      if (opts.tier !== "local") throw new Error("record needs BROWSER=local");
      const dir = await recordChore({
        name,
        site: o.site,
        startUrl: o.url ?? null,
        terminal: o.terminal ?? false,
        recordingsDir: settings.recordingsDir,
        browser: opts,
        io: { stdin: process.stdin, stdout: process.stdout },
      });
      console.log(`recording saved to ${dir}`);
    });

  program
    .command("agent <site> <goal>")
    .description(
      "An agent explores the site toward the goal, journaling every act; `--save <name>` writes the recording to compile. Loopback stays open for pause/resume.",
    )
    .option("--url <url>", "start here")
    .option("--input <k=v...>", "named values the goal may use (a file path, a domain)")
    .option("--save <name>", "recording name; default = from the goal")
    .option(
      "--codes <inbox>",
      'an inbox this system reads (autobrowse accounts): the agent may place{secret:"code"} with the code the site emails there',
    )
    .option("--max-steps <n>", "step budget", "25")
    .option("--port <port>", "loopback port", "9090")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .action(
      async (
        site: string,
        goal: string,
        o: {
          url?: string;
          input?: string[];
          save?: string;
          codes?: string;
          maxSteps: string;
          port: string;
          headed?: boolean;
        },
      ) => {
        let secrets: AgentRun["secrets"] = null;
        if (o.codes) {
          const { codeSecrets, signupHosts } = await import("../auth/signup.js");
          const { codesFor, gmailFor } = await import("./services.js");
          secrets = {
            names: ["code"],
            values: codeSecrets(
              codesFor(settings, gmailFor(settings)),
              await readableInbox(o.codes),
              new Date(),
            ),
            hosts: signupHosts(site, o.url ?? null),
          };
        }
        await runAgent(settings, {
          site,
          goal,
          url: o.url ?? null,
          inputs: parseInputs(o.input),
          secrets,
          save: o.save ?? slug(goal),
          maxSteps: Number(o.maxSteps),
          port: Number(o.port),
          headed: o.headed ?? false,
        });
      },
    );

  program
    .command("signup <site>")
    .description(
      "Make an account: the password is minted and stored sealed under <site> first, then the agent fills the signup placing email/password/code/phone by name (it never sees them); hands off at a captcha",
    )
    .option(
      "--email <address>",
      "the account's address; its codes are read from this inbox (default: your `signup` account, autobrowse accounts)",
    )
    .option("--for <purpose>", "which of your accounts makes it: signup, pays, …", "signup")
    .option("--inbox <address>", "read codes here instead (when --email is an alias of this inbox)")
    .option("--name <name>", "shown name")
    .option("--handle <handle>", "username or handle to ask for")
    .option("--birthday <date>", "when the form insists")
    .option("--url <url>", "the signup page (default: the site's home)")
    .option("--anyway", "sign up even if the site already knows the address")
    .option(
      "--by-hand",
      "the site's signup page has a bot check: open it in your own browser with the password on the clipboard, and wait for the site's first mail",
    )
    .option("--max-steps <n>", "step budget", "40")
    .option("--port <port>", "loopback port", "9090")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .action(
      async (
        site: string,
        o: {
          email?: string;
          for: string;
          inbox?: string;
          name?: string;
          handle?: string;
          birthday?: string;
          url?: string;
          anyway?: boolean;
          byHand?: boolean;
          maxSteps: string;
          port: string;
          headed?: boolean;
        },
      ) => {
        const { mintCredential, SIGNUP_SECRETS, signupGoal, signupHosts, signupSecrets } =
          await import("../auth/signup.js");
        const { codesFor, credentialsFor, gmailFor, identitiesFor, ourPhone } = await import(
          "./services.js"
        );
        const { identityFor } = await import("../auth/identities.js");
        const { signupInbox } = await import("../auth/signup.js");
        let email = o.email;
        if (!email) {
          const id = identityFor(await identitiesFor(settings).list(), o.for);
          if (!id)
            throw new Error(
              `no account for ${o.for}: autobrowse accounts add <address> --for ${o.for}, or give --email`,
            );
          email = id.address;
        }
        const inbox = o.inbox ?? email;
        const readable = signupInbox(inbox, {
          env: (n) => process.env[n],
          workspaceDomain: settings.googleWorkspaceDomain ?? null,
        });
        if (!readable)
          throw new Error(
            `${inbox}'s inbox is not readable, so the signup's code would never arrive: site setup gmail consent --account ${inbox} first, or --inbox one that is (autobrowse accounts)`,
          );
        // Look before creating. An address the site already knows needs a
        // password reset, not a second account — and only the site's own mail
        // can tell the two apart, whatever its pages say.
        const { lookForSiteAccount } = await import("./services.js");
        const look = await lookForSiteAccount({
          settings,
          site,
          email,
          inbox,
          headed: o.headed ?? false,
        });
        for (const line of look.why) console.log(`  ${line}`);
        if (look.verdict === "exists" && !o.anyway)
          throw new Error(
            `${site} already knows ${email}: reset its password instead (autobrowse login ${site}, or the site's forgot page), or pass --anyway`,
          );
        const account = {
          site,
          email,
          ...pick(o, ["inbox", "name", "handle", "birthday"]),
        };
        const cred = await mintCredential(credentialsFor(settings), account);
        console.log(`stored a new credential for ${site} (creds list); now the signup`);
        if (o.byHand) {
          await signUpByHand(site, { email, inbox, handle: o.handle ?? null, url: o.url ?? null });
          return;
        }
        // A site whose account is made by a call needs no browser at all.
        const { API_SIGNUPS } = await import("../auth/signup.js");
        const apiSignup = API_SIGNUPS[site];
        if (apiSignup) {
          const { httpClient } = await import("../clients/http.js");
          const { sinkFor } = await import("./services.js");
          const made = await apiSignup({
            http: httpClient(),
            cred,
            handle: o.handle ?? null,
          });
          console.log(`${site}: ${made.note}`);
          if (made.token) {
            await sinkFor(settings).put(made.token.name, made.token.value);
            console.log(`kept its token as ${made.token.name} (env list)`);
          }
          const store = credentialsFor(settings);
          const held = await store.get(site);
          if (held) await store.put(site, { ...held, madeAt: new Date().toISOString() });
          return;
        }
        const phone = ourPhone(settings);
        const secrets = signupSecrets({
          cred,
          codes: codesFor(settings, gmailFor(settings)),
          since: new Date(),
          phone,
        });
        const { achieved } = await runAgent(settings, {
          site,
          goal: signupGoal(account, phone),
          url: o.url ?? null,
          inputs: {},
          secrets: {
            names: SIGNUP_SECRETS,
            values: secrets,
            hosts: signupHosts(site, o.url ?? null),
          },
          save: `signup-${site}`,
          maxSteps: Number(o.maxSteps),
          port: Number(o.port),
          headed: o.headed ?? false,
        });
        if (achieved) {
          // The account exists now: `needs` stops asking for it.
          const store = credentialsFor(settings);
          const made = await store.get(site);
          if (made) await store.put(site, { ...made, madeAt: new Date().toISOString() });
          console.log(`${site}: account made; copied to the store`);
        }
      },
    );

  /**
   * The person fills the signup in their own browser (a bot check guards
   * it); everything around it stays automatic. The password is the one just
   * minted and sealed, handed over on the clipboard; the site's first mail to
   * the inbox is the proof the account exists, so the credential is marked
   * made without anyone saying so.
   */
  async function signUpByHand(
    site: string,
    a: { email: string; inbox: string; handle: string | null; url: string | null },
  ): Promise<void> {
    const { SIGNUP_PAGES } = await import("../auth/signup.js");
    const { RESET_FORMS, watchForSiteMail } = await import("../auth/exists.js");
    const { credentialsFor, gmailFor } = await import("./services.js");
    const { macClipboard } = await import("./cli-env.js");
    const page = a.url ?? SIGNUP_PAGES[site];
    if (!page) throw new Error(`no signup page mapped for ${site}: give --url`);
    const store = credentialsFor(settings);
    const cred = await store.get(site);
    if (!cred?.password) throw new Error(`no minted password for ${site}`);
    const since = new Date();
    await macClipboard(cred.password, HAND_CLIPBOARD_MS);
    if (process.platform === "darwin") {
      const { execFile } = await import("node:child_process");
      execFile("open", [page]);
    }
    console.log(
      [
        `${page} — in your own browser`,
        `  email     ${a.email}`,
        ...(a.handle ? [`  username  ${a.handle}`] : []),
        `  password  on the clipboard for ${HAND_CLIPBOARD_MS / 60_000} min (creds copy ${site} puts it back)`,
      ].join("\n"),
    );
    const form = RESET_FORMS[site];
    if (!form) {
      console.log(`no sender mapped for ${site}: when you are done, autobrowse creds made ${site}`);
      return;
    }
    console.log(
      `waiting for ${site}'s first mail to ${a.inbox} (up to ${HAND_WAIT_MS / 60_000} min)…`,
    );
    const hit = await watchForSiteMail({
      form,
      inbox: a.inbox,
      mail: gmailFor(settings),
      since,
      waitMs: HAND_WAIT_MS,
    });
    if (!hit)
      throw new Error(
        `no mail from ${site} yet: finish the signup, then autobrowse creds made ${site}`,
      );
    // A site that asked for a username signs in with it; the address stays as the codes inbox.
    const held = await store.get(site);
    if (held)
      await store.put(site, {
        ...held,
        ...(a.handle ? { username: a.handle, codesInbox: a.inbox } : {}),
        madeAt: new Date().toISOString(),
      });
    console.log(
      `${site} wrote ("${hit.subject}"): account made. autobrowse needs shows what is next`,
    );
  }

  program
    .command("known <site>")
    .description(
      "Does the site already have an account on this address? Its forgot-password page is asked to write, and the inbox answers; nothing is changed either way",
    )
    .option(
      "--email <address>",
      "the address to ask about (default: your `signup` account, autobrowse accounts)",
    )
    .option("--for <purpose>", "which of your accounts to ask about: signup, pays, …", "signup")
    .option("--inbox <address>", "read the answer here instead (when --email is an alias of it)")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .action(
      async (
        site: string,
        o: { email?: string; for: string; inbox?: string; headed?: boolean },
      ) => {
        const { identitiesFor, lookForSiteAccount } = await import("./services.js");
        const { identityFor } = await import("../auth/identities.js");
        let email = o.email;
        if (!email) {
          const id = identityFor(await identitiesFor(settings).list(), o.for);
          if (!id)
            throw new Error(
              `no account for ${o.for}: autobrowse accounts add <address> --for ${o.for}, or give --email`,
            );
          email = id.address;
        }
        const look = await lookForSiteAccount({
          settings,
          site,
          email,
          inbox: o.inbox ?? email,
          headed: o.headed ?? false,
        });
        for (const line of look.why) console.log(`  ${line}`);
        console.log(`${site} · ${email}: ${look.verdict}`);
      },
    );

  program
    .command("repair <failure> [goal]")
    .description(
      "A flow stopped (its <stamp>.failure.json is under the artifacts dir): the agent picks up on that page toward the flow's goal, or the goal you give, and records the way through",
    )
    .option("--input <k=v...>", "named values the goal may use")
    .option("--max-steps <n>", "step budget", "25")
    .option("--port <port>", "loopback port", "9090")
    .option("--headed", "show the browser (default: BROWSER_HEADLESS)")
    .action(
      async (
        failure: string,
        goal: string | undefined,
        o: { input?: string[]; maxSteps: string; port: string; headed?: boolean },
      ) => {
        const { readFailure, repairGoal, repairName } = await import("../agent/repair.js");
        const record = readFailure(failure);
        console.log(`repairing ${record.site}/${record.flow} (${record.kind}: ${record.error})`);
        await runAgent(settings, {
          site: record.site,
          goal: repairGoal(record, goal),
          url: record.url,
          inputs: parseInputs(o.input),
          save: repairName(record),
          maxSteps: Number(o.maxSteps),
          port: Number(o.port),
          headed: o.headed ?? false,
        });
      },
    );

  program
    .command("heal <failure>")
    .description(
      "A failed compiled step: the agent finishes it on the page, the step is rewritten from what it did, the flow is proven again",
    )
    .option("--no-prove", "rewrite only; skip the proof run")
    .action(async (failure: string, o: { prove: boolean }) => {
      const { healLine } = await import("../agent/heal.js");
      const { readFailure } = await import("../agent/repair.js");
      const { backend } = local({ proveAfterHeal: o.prove });
      if (!backend.heal)
        throw new Error("heal needs a model: set a model key or LLM_PROVIDER=claude-code");
      const out = await backend.heal(readFailure(failure, backend.artifactsDir));
      console.log(healLine(out));
      if (out.status !== "healed") process.exitCode = 1;
    });
  program
    .command("compile <name>")
    .description(
      `Recording → workflow module under ${COMPILED_DIR}, with its editable outline.json beside it`,
    )
    .option("--no-llm", "skip the model pass (names, proofs); pure template output")
    .option("--from-outline", "re-render <name>'s edited outline.json instead of re-structuring")
    .option(
      "--finish",
      "then a model finishes it (plan inputs, send gate, proof read) until tsc and its test pass",
    )
    .action(async (name: string, o: { llm: boolean; fromOutline?: boolean; finish?: boolean }) => {
      const { loadRecording } = await import("../recorder/store.js");
      const { backend } = local({ llm: o.llm });
      if (o.llm && !backend.llm) console.log("no model key set; template output only");
      let out: Awaited<ReturnType<typeof backend.compile>>;
      if (o.fromOutline) {
        if (!backend.outline) throw new Error("no outline editor here");
        const outline = await backend.outline.load(name);
        if (!outline) throw new Error(`${name} has no outline.json under ${COMPILED_DIR}`);
        out = await backend.outline.save(name, outline);
      } else {
        out = await backend.compile(await loadRecording(backend.recordingsDir, name));
      }
      for (const f of Object.keys(out.files)) console.log(join(COMPILED_DIR, out.outline.name, f));
      if (out.usage)
        console.log(`model: ${out.usage.inputTokens} in / ${out.usage.outputTokens} out`);
      console.log(
        `steps: ${out.outline.steps.map((s) => `${s.name}${s.irreversible ? "!" : ""}`).join(" → ")}`,
      );
      if (o.finish) {
        if (!backend.finish) throw new Error("--finish needs a model: set a model key");
        console.log(finishLine(await backend.finish(out.outline.name)));
      }
    });
  program
    .command("finish <name>")
    .description(
      `A model finishes the compiled workflow under ${COMPILED_DIR}/<name> (plan inputs, a send gate before the irreversible step, a proof read, a gate test), judged by tsc and its test; the files stay as they were when it gives up`,
    )
    .option("--brief <text>", "something to tell the model (what to add, what the site does)")
    .option("--rounds <n>", "model rounds before it gives up", "3")
    .action(async (name: string, o: { brief?: string; rounds: string }) => {
      const { backend } = local();
      if (!backend.finish) throw new Error("finish needs a model: set a model key");
      const out = await backend.finish(name, {
        ...(o.brief ? { brief: o.brief } : {}),
        rounds: Number(o.rounds),
        onRound: (round, errors) =>
          console.log(`round ${round} failed: ${errors.split("\n").slice(0, 2).join(" ")}`),
      });
      console.log(finishLine(out));
      if (out.status === "gave-up") process.exitCode = 1;
    });
}

function finishLine(out: {
  status: string;
  rounds: number;
  summary: string;
  usage: { inputTokens: number; outputTokens: number };
}): string {
  return `finish: ${out.status} after ${out.rounds} round(s), ${out.usage.inputTokens} in / ${out.usage.outputTokens} out — ${out.summary}`;
}

interface AgentRun {
  site: string;
  goal: string;
  url: string | null;
  inputs: Record<string, string>;
  save: string;
  maxSteps: number;
  port: number;
  headed: boolean;
  /** Named values the agent may `place` and never sees; `hosts` says where they may land. */
  secrets?: {
    names: readonly string[];
    values: SecretValues;
    hosts: (host: string) => boolean;
  } | null;
}

/** One agent session: explore server up, agent to the goal, journal saved as a recording. */
async function runAgent(settings: Settings, r: AgentRun): Promise<{ achieved: boolean }> {
  const { exploreWithAgent } = await import("../agent/explorer.js");
  const llm = llmFor(settings);
  if (!llm) throw new Error("the agent needs a model: set LLM_PROVIDER and its key");
  const ex = await explorerOpener(settings, undefined, r.headed ? headed : undefined)(
    r.site,
    r.port,
    r.secrets ? { secrets: r.secrets.values, secretHosts: r.secrets.hosts } : {},
  );
  console.log(
    `agent on ${r.site}; pause/resume: curl -s -X POST -H "Authorization: Bearer ${ex.token}" http://127.0.0.1:${ex.port}/ -d '{"cmd":"pause"}'`,
  );
  try {
    if (r.url) await ex.exec({ cmd: "open", url: r.url });
    const { stepLedgerFor } = await import("./services.js");
    const result = await exploreWithAgent({
      explorer: ex,
      llm,
      goal: r.goal,
      inputs: r.inputs,
      site: r.site,
      ledger: stepLedgerFor(settings),
      ...(r.secrets ? { secrets: r.secrets.names } : {}),
      maxSteps: r.maxSteps,
      // Headed, the person does the captcha in the window and presses enter here.
      onHuman: async (reason) => {
        if (!r.headed) return false;
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const a = await rl.question(`needs you: ${reason}\nwhen done press enter (q to stop) `);
          return a.trim().toLowerCase() !== "q";
        } finally {
          rl.close();
        }
      },
      onStep: (s) =>
        console.log(
          `${s.n}. ${s.step?.thought ?? "(unparsable reply)"}\n   ${s.step?.action.cmd ?? "-"} ${s.error ? `✗ ${s.error}` : "✓"}`,
        ),
    });
    console.log(`${result.achieved ? "achieved" : "not achieved"}: ${result.summary}`);
    console.log(`tokens in ${result.usage.inputTokens} out ${result.usage.outputTokens}`);
    const saved = (await ex.exec({ cmd: "save", name: r.save })) as { dir: string };
    console.log(`recording: ${saved.dir}  →  pnpm autobrowse compile ${r.save}`);
    return { achieved: result.achieved };
  } finally {
    await ex.exec({ cmd: "close" });
  }
}

/** The keys of `o` that are set, as an object: options into a record without the undefined ones. */
function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function parseInputs(kvs: string[] | undefined): Record<string, string> {
  return Object.fromEntries(
    (kvs ?? []).map((kv) => {
      const i = kv.indexOf("=");
      return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
}

/** A recording name from free text: lowercase, dashes, starts with a letter. */
function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  return /^[a-z]/.test(s) ? s : `r-${s}`;
}
