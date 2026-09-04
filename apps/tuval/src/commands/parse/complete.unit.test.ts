import {describe, expect, it} from "vitest";
import {complete} from "./complete.ts";
import {registry, snapshot} from "./fixtures.ts";

const values = (input: string) => complete(input, registry, snapshot).map((c) => c.value);

describe("complete — exact prefix over system names", () => {
	it("ranks spell path segments by prefix and never by fuzzy match", () => {
		// `wizard-inspect` holds w, i and n in order, and is still not offered.
		expect(values("win")).toEqual(["window"]);
		expect(values("w")).toEqual(["window", "workspace", "wizard-inspect"]);
	});

	it("offers the segments under the node the caret sits in", () => {
		expect(values("window ")).toEqual(["close", "move"]);
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

	it("offers every live value of the set when nothing is typed yet", () => {
		expect(values("process kill ")).toEqual(["p-counter", "p-client"]);
	});

	it("breaks a tie on snapshot order", () => {
		expect(values("process kill p-")).toEqual(["p-counter", "p-client"]);
	});

	it("offers nothing for a parameter that names no live set", () => {
		expect(values("workspace rename ws-2 ")).toEqual([]);
	});
});

describe("complete — determinism", () => {
	it("returns an equal list for equal input and snapshot", () => {
		for (const input of ["win", "window move ", "workspace activate scr", "process kill p-"]) {
			expect(complete(input, registry, snapshot)).toEqual(complete(input, registry, snapshot));
		}
	});
});
