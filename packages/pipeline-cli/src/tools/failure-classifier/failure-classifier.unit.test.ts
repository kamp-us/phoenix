import {describe, expect, it} from "vitest";
import {type CrashSignal, classify} from "./failure-classifier.ts";

const sig = (over: Partial<CrashSignal> = {}): CrashSignal => ({...over});

describe("classify — canonical TRANSIENT cases (safe to auto-resume)", () => {
	it("null subagent result → transient", () => {
		const v = classify(sig({reason: "stage review returned a null subagent result"}));
		expect(v.class).toBe("transient");
		expect(v.rationale).toMatch(/null subagent result/);
	});

	it("subagent returned null → transient", () => {
		expect(classify(sig({reason: "the subagent returned null"})).class).toBe("transient");
	});

	it("API / session-limit death → transient", () => {
		expect(classify(sig({reason: "subagent hit the API rate-limit and died"})).class).toBe(
			"transient",
		);
		expect(classify(sig({reason: "session-limit reached"})).class).toBe("transient");
		expect(classify(sig({errorKind: "usage-limit"})).class).toBe("transient");
	});

	it("process exit / whole-process death on a model switch → transient", () => {
		expect(classify(sig({reason: "parent process exited"})).class).toBe("transient");
		expect(classify(sig({reason: "whole-process death on a model switch"})).class).toBe(
			"transient",
		);
		expect(classify(sig({errorKind: "process_exit"})).class).toBe("transient");
	});

	it("matches on errorKind as well as reason", () => {
		const v = classify(sig({errorKind: "overloaded", reason: ""}));
		expect(v.class).toBe("transient");
	});
});

describe("classify — canonical LOGIC cases (never resume, surface immediately)", () => {
	it("null deref → logic", () => {
		const v = classify(
			sig({reason: "TypeError: Cannot read properties of undefined (reading 'x')"}),
		);
		expect(v.class).toBe("logic");
		expect(v.rationale).toMatch(/dereference|type error/i);
	});

	it("wrong-arg-type → logic", () => {
		expect(
			classify(sig({reason: "Argument of type 'string' is not assignable to parameter"})).class,
		).toBe("logic");
	});

	it("schema mismatch → logic", () => {
		expect(
			classify(sig({reason: "schema mismatch: failed to parse the structured output"})).class,
		).toBe("logic");
	});
});

describe("classify — default-deny fallthrough (the safety property)", () => {
	it("an unrecognized / ambiguous crash reason classifies as logic, never transient", () => {
		const v = classify(sig({reason: "something weird went wrong nobody has a signature for"}));
		expect(v.class).toBe("logic");
		expect(v.class).not.toBe("transient");
		expect(v.rationale).toMatch(/default-deny/i);
	});

	it("an empty crash signal classifies as logic (default-deny), never transient", () => {
		const v = classify(sig({}));
		expect(v.class).toBe("logic");
		expect(v.class).not.toBe("transient");
	});

	it("the ambiguous-input path NEVER returns transient (invariant over a sweep of unknown reasons)", () => {
		const unknowns = [
			"opaque failure code 0xdead",
			"the flux capacitor destabilized",
			"stage X did not complete for reasons unknown",
			"",
			"   ",
			"error",
		];
		for (const reason of unknowns) {
			expect(classify(sig({reason})).class).not.toBe("transient");
		}
	});
});

describe("classify — rationale + stage carry-through", () => {
	it("carries the failed stage into the rationale without letting it decide the class", () => {
		const v = classify(sig({reason: "null subagent result", stage: "review-code"}));
		expect(v.class).toBe("transient");
		expect(v.rationale).toMatch(/review-code/);
	});

	it("stage alone (no reason) does not flip the default-deny verdict", () => {
		const v = classify(sig({stage: "ship"}));
		expect(v.class).toBe("logic");
	});
});
