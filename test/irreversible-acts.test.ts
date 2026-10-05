/** Acts a rerun must never redo carry the irreversible mark: the runner's done-ledger keys on it. */
import { describe, expect, it } from "vitest";
import { googleDkimGenerate } from "../src/browser/flows/google-dkim.js";
import { port25RequestFlow } from "../src/workflows/aws-port25-request/index.js";
import { fakeSite } from "./site-fakes.js";

describe("aws port25-request", () => {
  it("the submit is irreversible: a rerun after a crash never files a second request", async () => {
    const form = [
      "textbox:Email address",
      "textbox:Use case description",
      "textbox:Elastic IP address - optional",
      "textbox:Reverse DNS record - optional",
      "button:Submit",
    ];
    const site = fakeSite({ form: { has: form, text: "Thank you, submitted" } }, "form");
    await port25RequestFlow.run(site.fp, {
      contactEmail: "owner@example.com",
      useCaseDescription: "probes",
      elasticIpAddress: "",
      reverseDnsRecord: "",
      submit: true,
    });
    expect(site.marked).toEqual(["submit the request"]);
  });
});

describe("google-admin dkim-generate", () => {
  const domain = ["listbox:Selected domain", "option:example.com"];
  const run = async (start: "fresh" | "shown") => {
    const site = fakeSite(
      {
        fresh: {
          has: [...domain, "button:Generate new record"],
          on: { "click button:Generate new record": "dialog" },
        },
        dialog: { has: [...domain, "button:Generate"], on: { "click button:Generate": "shown" } },
        shown: { has: [...domain, "text:v=DKIM1; k=rsa; p=AB"] },
      },
      start,
    );
    // The selected-option wait reads the page itself.
    Object.assign(site.fp, {
      page: { getByRole: () => ({ getByRole: () => ({ waitFor: async () => {} }) }) },
    });
    const out = await googleDkimGenerate.run(site.fp, { domain: "example.com" });
    return { out, marked: site.marked };
  };

  it("generates once, marked irreversible: a rerun never rotates the key", async () => {
    expect(await run("fresh")).toEqual({
      out: { name: "google._domainkey", value: "v=DKIM1; k=rsa; p=AB" },
      marked: ["generate the DKIM key (a second one rotates it)"],
    });
  });

  it("a key already shown is read, not regenerated", async () => {
    expect((await run("shown")).marked).toEqual([]);
  });
});
