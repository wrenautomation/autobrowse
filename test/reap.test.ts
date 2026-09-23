import { describe, expect, it } from "vitest";
import { orphanBrowsers, reapOrphans } from "../src/browser/reap.js";

const dir = "/home/u/.config/autobrowse/profiles";
const procs = [
  // Owner died: the root went to init.
  { pid: 10, ppid: 1, command: `/chrome --user-data-dir=${dir}/npm --headless` },
  { pid: 11, ppid: 10, command: `/chrome --type=renderer --user-data-dir=${dir}/npm` },
  // Owner alive: an explore server still holds it.
  { pid: 20, ppid: 500, command: `/chrome --user-data-dir=${dir}/langfuse` },
  // A person's own Chrome, not ours.
  { pid: 30, ppid: 1, command: "/chrome --user-data-dir=/Users/u/Library/Chrome" },
];

describe("orphaned browsers", () => {
  it("only roots on our profiles whose owner died", () => {
    expect(orphanBrowsers(procs, `${dir}/`, 4242)).toEqual([{ pid: 10, profile: "npm" }]);
  });
  it("never in a container where we are init: ppid 1 is then our own", () => {
    expect(orphanBrowsers(procs, dir, 1)).toEqual([]);
  });
  it("stops them, and a dry run only names them", async () => {
    const killed: number[] = [];
    const o = { procs: async () => procs, kill: (pid: number) => void killed.push(pid) };
    expect(await reapOrphans(dir, { ...o, dry: true })).toHaveLength(1);
    expect(killed).toEqual([]);
    expect(await reapOrphans(dir, o)).toEqual([{ pid: 10, profile: "npm" }]);
    expect(killed).toEqual([10]);
  });
});
