/** Eyes from any model that sees: the captcha picture and the question, one JSON answer back. */
import type { Llm } from "../../llm/index.js";
import type { Eyes } from "./index.js";

export function eyesOf(llm: Llm): Eyes {
  return {
    async look(png, question) {
      const reply = await llm.complete({
        system:
          "You solve captchas on the account owner's own browser, with their permission. Answer with the JSON object asked for, nothing else.",
        prompt: question,
        images: [{ mediaType: "image/png", data: png.toString("base64") }],
        json: true,
        maxTokens: 300,
      });
      return reply.text;
    },
  };
}
