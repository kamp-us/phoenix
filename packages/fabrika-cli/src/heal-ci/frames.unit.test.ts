import {describe, expect, it} from "vitest";
import {parseFrames, renderFrame} from "./frames.ts";

const frame = (context: string, text: string) =>
	renderFrame({context, jobId: "441", bytes: text.length, truncated: false, text});

describe("parseFrames", () => {
	it("round-trips what renderFrame writes", () => {
		const parsed = parseFrames(frame("unit tests", "FAIL a\nAssertionError"));
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.context).toBe("unit tests");
		expect(parsed[0]?.text).toBe("FAIL a\nAssertionError");
	});

	it("splits N contexts into N blocks, in the order received", () => {
		const stream = ["logs\t2\tabc", frame("a", "one"), frame("b", "two")].join("\n");
		expect(parseFrames(stream).map((block) => block.context)).toEqual(["a", "b"]);
	});

	it("drops the header line rather than classifying it as a block", () => {
		const stream = ["logs\t1\tabc", frame("a", "one")].join("\n");
		expect(parseFrames(stream)).toHaveLength(1);
	});

	it("treats an unframed body as one block under the null context", () => {
		const parsed = parseFrames("Error: connect ETIMEDOUT\n");
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.context).toBe("-");
		expect(parsed[0]?.text).toBe("Error: connect ETIMEDOUT");
	});

	it("keeps an unterminated frame's bytes rather than answering that nothing failed", () => {
		const cut = frame("a", "boom").split("\n").slice(0, 2).join("\n");
		const parsed = parseFrames(cut);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.truncated).toBe(true);
		expect(parsed[0]?.text).toBe("boom");
	});
});
