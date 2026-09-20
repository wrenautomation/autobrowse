/** `autobrowse desktop …`: the desktop leg from a terminal (a look, a click, root setup). */
import { writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { macDesktop, rootHelper, rootSetupCommands } from "../desktop/mac.js";
import { treeText } from "../desktop/types.js";

export function registerDesktopCommands(program: Command, scratchDir: string): void {
  const desktop = program
    .command("desktop")
    .description("The desktop outside the browser: apps, menus, dialogs, root commands");
  desktop
    .command("setup")
    .description(
      "Say what the desktop leg still needs (Accessibility for this terminal, the root helper) and how to grant it",
    )
    .action(async () => {
      const d = macDesktop();
      const p = await d.permissions();
      console.log(`accessibility: ${p.accessibility ? "granted" : "missing"}`);
      if (!p.accessibility) {
        console.log(
          "  System Settings → Privacy & Security → Accessibility → add the app running this (Terminal, iTerm, VS Code).",
        );
        await d.shell(
          'open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"',
        );
      }
      console.log(`root: ${p.root ? "ready" : "missing"}`);
      if (!p.root) {
        const file = join(scratchDir, "autobrowse-root");
        writeFileSync(file, rootHelper(), { mode: 0o755 });
        console.log(
          "  run once (asks for your password); every root command is logged to the file the helper names:",
        );
        for (const c of rootSetupCommands(userInfo().username, file)) console.log(`  ${c}`);
      }
    });
  desktop
    .command("apps")
    .description("Running apps with a window")
    .action(async () => {
      for (const a of await macDesktop().apps()) console.log(a);
    });
  desktop
    .command("tree [app]")
    .description(
      "The front app's controls (or the named app's), role and name per line, like `aria`",
    )
    .option("--depth <n>", "how deep to walk", "8")
    .action(async (app: string | undefined, o: { depth: string }) => {
      console.log(treeText(await macDesktop().tree(app, Number(o.depth))));
    });
}
