import {describe, expect, it} from "vitest";
import {complete, subsequenceScore} from "./complete.ts";
import {registry, snapshot} from "./fixtures.ts";

const values = (input: string) => complete(input, registry, snapshot).map((c) => c.value);

describe("complete — exact prefix over system names", () => {
	it("ranks spell path segments by prefix and never by fuzzy match", () => {
		// `wizard-inspect` holds w, i and n in order, and is still not offered.
		expect(values("win")).toEqual(["window"]);
		expect(values("w")).toEqual(["window", "workspace", "wizard-inspect"]);
	});

	it("offers the segments under the node the caret sits in", () => {
		expect(values("window ")).toEqual(["close", "move", "focus"]);
		expect(values("window c")).toEqual(["close"]);
	});

	it("carries a segment's one-line description when it completes a whole spell", () => {
		expect(complete("window c", registry, snapshot)).toEqual([
			{value: "close", kind: "segment", describe: "Close the focused window."},
		]);
	});

	it("completes an enum parameter by prefix on its literals", () => {
		expect(values("window move ")).toEqual(["left", "right", "up", "down"]);
		expect(values("window move l")).toEqual(["left"]);
		expect(values("window move r")).toEqual(["right"]);
		expect(values("window move z")).toEqual([]);
	});

	it("completes a program id by prefix, never fuzzily", () => {
		expect(values("process spawn c")).toEqual(["counter"]);
	});
});

describe("complete — fuzzy subsequence over user-named values", () => {
	it("ranks the snapshot's workspace names fuzzily, tightest first", () => {
		expect(values("workspace activate scr")).toEqual(["scratch", "super-carrier"]);
	});

	it("offers every live value of the set when nothing is typed yet, most recent first", () => {
		// Every value scores the same on an empty query, so this is the tie-break on its own:
		// `p-client` carries the higher recency stamp and `p-counter` comes first in the snapshot.
		expect(values("process kill ")).toEqual(["p-client", "p-counter"]);
	});

	it("breaks a tie on recency, most recent first — not on snapshot order (#7617 R1.5)", () => {
		expect(values("process kill p-")).toEqual(["p-client", "p-counter"]);
		expect(values("window move ")).toEqual(["left", "right", "up", "down"]);
	});

	it("breaks a window tie on recency too, against the order the record lists them in", () => {
		// `w-left` is the first key of `snapshot.windows`, and `w-right` was focused later.
		expect(values("window focus w-")).toEqual(["w-right", "w-left"]);
	});

	it("keeps the tighter match ahead of the more recent one", () => {
		// Recency only breaks a tie: `p-counter` is not a tighter match than `p-client` here, but
		// `scratch` is a tighter match than `super-carrier` and neither carries a stamp.
		expect(values("workspace activate scr")).toEqual(["scratch", "super-carrier"]);
	});

	it("offers nothing for a parameter that names no live set", () => {
		expect(values("workspace rename ws-2 ")).toEqual([]);
	});

	it("scores the tightest run in the value, not the first run it finds (#7757)", () => {
		// `ab` sits in `a-xb-ab` twice: scattered at 0-3, contiguous at 5-6. The greedy walk locked
		// on the first `a` and answered 3000; the tightest run is 5-6.
		expect(subsequenceScore("a-xb-ab", "ab")).toBe(1005);
	});

	it("ranks a tight run behind a looser earlier one ahead of an only-looser value (#7757)", () => {
		// `a-b` matches at 0-2 and nowhere tighter, so it trails `a-xb-ab`'s contiguous run.
		expect(values("workspace activate ab")).toEqual(["a-xb-ab", "a-b"]);
	});
});

describe("complete — one case rule over both matchers (#7757)", () => {
	it("matches a prefix-ranked kind regardless of case", () => {
		expect(values("W")).toEqual(values("w"));
		expect(values("window move L")).toEqual(["left"]);
		expect(values("process spawn C")).toEqual(["counter"]);
	});

	it("matches a fuzzy-ranked kind regardless of case", () => {
		expect(values("workspace activate SCR")).toEqual(values("workspace activate scr"));
		expect(values("workspace activate SCR")).toEqual(["scratch", "super-carrier"]);
	});
});

describe("complete — determinism", () => {
	it("returns an equal list for equal input and snapshot", () => {
		for (const input of ["win", "window move ", "workspace activate scr", "process kill p-"]) {
			expect(complete(input, registry, snapshot)).toEqual(complete(input, registry, snapshot));
		}
	});
});
