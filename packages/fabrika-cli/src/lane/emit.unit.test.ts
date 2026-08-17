/**
 * The pure epic-machine emitter: golden bytes off the committed fixture pair, determinism, the
 * compile/transition round trip, and every topology refusal as its own tagged arm.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {readGoldenFixture} from "../golden-fixture.ts";
import {type EmitResult, emitMachine} from "./emit.ts";
import {compileText} from "./machine.ts";
import {runTransition} from "./transition-verb.ts";

const body = (): string => readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.body.txt");
const golden = (): string =>
	readGoldenFixture(import.meta.url, "./__fixtures__/epic-4300.workflow.golden.txt");

const open = (number: number) => ({number, state: "open" as const, stateReason: null});
const closed = (number: number, stateReason: string | null = "completed") => ({
	number,
	state: "closed" as const,
	stateReason,
});

const CHILDREN = [open(4301), open(4302), open(4303)];

const initialOf = (text: string, task: string): unknown => {
	const doc = JSON.parse(text) as {
		machine: {states: Record<string, {states: Record<string, {initial: string}>}>};
	};
	for (const phase of Object.values(doc.machine.states)) {
		const node = phase.states?.[task];
		if (node !== undefined) return node.initial;
	}
	throw new Error(`no region for ${task}`);
};

const emitted = (result: EmitResult): string => {
	if (result._tag !== "Emitted") throw new Error(`expected Emitted, got ${result._tag}`);
	return result.text;
};

describe("emitMachine", () => {
	it("emits the golden machine bytes from the golden epic body", () => {
		expect(emitted(emitMachine(4300, body(), CHILDREN))).toBe(golden());
	});

	it("is deterministic — the same body bytes emit the same machine bytes", () => {
		expect(emitted(emitMachine(4300, body(), CHILDREN))).toBe(
			emitted(emitMachine(4300, body(), CHILDREN)),
		);
	});

	it("emits a machine the lane compiler accepts without repair", () => {
		const compiled = compileText(emitted(emitMachine(4300, body(), CHILDREN)));
		if (compiled._tag !== "Compiled") throw new Error(compiled.defects.join("; "));
		expect(compiled.lane.phases).toEqual([
			{name: "phase1", tasks: ["issue_4301", "issue_4302"]},
			{name: "phase2", tasks: ["issue_4303"]},
		]);
		expect(compiled.lane.terminals).toEqual({complete: "complete", tripped: "tripped"});
	});

	it("emits a machine whose states and events `lane transition` accepts", async () => {
		const fs = fakeFs({
			files: {".fabrika/lanes/4300/workflow.json": emitted(emitMachine(4300, body(), CHILDREN))},
		});
		const out = await Effect.runPromise(
			Effect.provide(
				runTransition({root: ".fabrika/lanes", lane: "4300", event: "WIP", task: "issue_4301"}),
				fs.layer,
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			event: "ISSUE_4301.WIP",
			current: {phase1: {issue_4301: "build", issue_4302: "queued"}, phase2: "waiting"},
		});
	});

	it("emits an all-open epic byte-identically to the golden bytes — state widened nothing", () => {
		expect(emitted(emitMachine(4300, body(), [open(4301), open(4302), open(4303)]))).toBe(golden());
	});

	it("boots a completed-closed child in `shipped` and leaves its open siblings queued", () => {
		const text = emitted(emitMachine(4300, body(), [closed(4301), open(4302), open(4303)]));
		expect(initialOf(text, "issue_4301")).toBe("shipped");
		expect(initialOf(text, "issue_4302")).toBe("queued");
	});

	it("boots a child closed for any other reason in `frozen` — a close is never a landing", () => {
		const text = emitted(
			emitMachine(4300, body(), [closed(4301, "not_planned"), open(4302), open(4303)]),
		);
		expect(initialOf(text, "issue_4301")).toBe("frozen");
		const legacy = emitted(emitMachine(4300, body(), [closed(4301, null), open(4302), open(4303)]));
		expect(initialOf(legacy, "issue_4301")).toBe("frozen");
	});

	it("skips a fully-shipped phase at boot — its onDone fires with no human UNBLOCKED", async () => {
		const text = emitted(emitMachine(4300, body(), [closed(4301), closed(4302), open(4303)]));
		const fs = fakeFs({files: {".fabrika/lanes/4300/workflow.json": text}});
		const out = await Effect.runPromise(
			Effect.provide(
				runTransition({root: ".fabrika/lanes", lane: "4300", event: "WIP", task: "issue_4303"}),
				fs.layer,
			),
		);
		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toMatchObject({
			event: "ISSUE_4303.WIP",
			previous: {phase2: {issue_4303: "queued"}},
			current: {phase2: {issue_4303: "build"}},
		});
	});

	it("refuses a body with no ## Dependencies block", () => {
		expect(emitMachine(4300, "## Plan\n\nno topology here\n", CHILDREN)).toEqual({
			_tag: "NoTopology",
		});
	});

	it("refuses a block that parses to zero phase lines as no topology", () => {
		expect(emitMachine(4300, "## Dependencies\n\n", CHILDREN)).toEqual({_tag: "NoTopology"});
	});

	it("refuses a phase member that is not a child of the epic, naming it", () => {
		expect(emitMachine(4300, "## Dependencies\n\n- phase 1: #9999\n", CHILDREN)).toEqual({
			_tag: "Foreign",
			ref: "#9999",
		});
	});

	it("refuses a requires reference that is not a child of the epic", () => {
		const text = "## Dependencies\n\n- phase 1: #4301\n- #4301 requires: #9999\n";
		expect(emitMachine(4300, text, CHILDREN)).toEqual({_tag: "Foreign", ref: "#9999"});
	});

	it("refuses a ledger-local ref — an epic on the board holds only real issues", () => {
		expect(emitMachine(4300, "## Dependencies\n\n- phase 1: C1\n", CHILDREN)).toEqual({
			_tag: "Foreign",
			ref: "C1",
		});
	});

	it("refuses a cycle, naming the ref path", () => {
		const text =
			"## Dependencies\n\n- phase 1: #4301, #4302\n- #4301 requires: #4302\n- #4302 requires: #4301\n";
		const out = emitMachine(4300, text, CHILDREN);
		if (out._tag !== "Cycle") throw new Error(`expected Cycle, got ${out._tag}`);
		expect(out.path.length).toBeGreaterThan(2);
	});

	it("refuses a line under the heading that does not parse, naming it", () => {
		const out = emitMachine(4300, "## Dependencies\n\n- phase one: #4301\n", CHILDREN);
		expect(out).toMatchObject({_tag: "Unparseable", text: "- phase one: #4301"});
	});

	it("refuses a child placed in two phases", () => {
		const text = "## Dependencies\n\n- phase 1: #4301\n- phase 2: #4301\n";
		expect(emitMachine(4300, text, CHILDREN)).toEqual({_tag: "Duplicate", child: 4301});
	});

	it("refuses a requires subject placed in no phase", () => {
		const text = "## Dependencies\n\n- phase 1: #4301\n- #4303 requires: #4301\n";
		expect(emitMachine(4300, text, CHILDREN)).toEqual({_tag: "Unplaced", child: 4303});
	});
});
