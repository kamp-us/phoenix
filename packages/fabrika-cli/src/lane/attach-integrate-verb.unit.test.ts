/** `lane attach-integrate` — what it appends to a wedged integrate FAIL, and what it refuses. */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {runAttachIntegrate} from "./attach-integrate-verb.ts";
import {INTEGRATE_EVIDENCE, TASK_UNKNOWN} from "./codes.ts";
import {emitMachine} from "./emit.ts";
import {laneWrites} from "./fixtures.test-support.ts";
import {applyCorrections, foldLog, parseLog} from "./fold.ts";
import {standingIntegrateFailure} from "./integrate-failure.ts";
import {compileText} from "./machine.ts";

const ROOT = ".fabrika/lanes";
const EPIC = "900";
const CHILD = 5828;
const TASK = `issue_${CHILD}`;
const LOG = `${ROOT}/${EPIC}/events.jsonl`;
const HEAD = "9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4";
const NOW = "2026-09-27T03:00:00.000Z";
const at = (n: number): string => `2026-09-20T18:0${n}:00.000Z`;

const emitted = (() => {
	const result = emitMachine(Number(EPIC), `## Dependencies\n\n- phase 1: #${CHILD}\n`, [
		{number: CHILD, state: "open", stateReason: null, classes: []},
	]);
	if (result._tag !== "Emitted") throw new Error(`the epic fixture did not emit: ${result._tag}`);
	return result.text;
})();

const line = (event: string, when: string, extra: Record<string, unknown> = {}): string =>
	`${JSON.stringify({task: TASK, event: `${TASK.toUpperCase()}.${event}`, at: when, ...extra})}\n`;

/** Reviewed, passed, then failed `lane integrate` before the pair existed — now folded into build. */
const WEDGED = `${line("WIP", at(0))}${line("DONE", at(1))}${line("PASS", at(2))}${line("FAIL", at(3))}`;

const ledger = (log: string) =>
	fakeFs({files: {[`${ROOT}/${EPIC}/workflow.json`]: emitted, [LOG]: log}});

const run = (
	fs: ReturnType<typeof ledger>,
	extra: Partial<{task: string | null; at: string; exit: number; head: string}> = {},
) =>
	Effect.runPromise(
		Effect.provide(
			runAttachIntegrate({
				root: ROOT,
				lane: EPIC,
				task: extra.task === undefined ? TASK : extra.task,
				at: extra.at ?? at(3),
				integrateExit: extra.exit ?? 43,
				assemblyHead: extra.head ?? HEAD,
				now: () => new Date(NOW),
			}),
			fs.layer,
		),
	);

const compiled = () => {
	const lane = compileText(emitted);
	if (lane._tag !== "Compiled") throw new Error("the epic fixture did not compile");
	return lane.lane;
};

const leafOf = (log: string): string => {
	const parsed = parseLog(log);
	if (parsed._tag !== "Parsed") throw new Error(parsed.defects.join("; "));
	const folded = foldLog(compiled(), parsed.entries);
	if (folded._tag !== "Folded") throw new Error(folded.defects.join("; "));
	return folded.states[TASK]?.type ?? "";
};

describe("lane attach-integrate — a pair-less integrate FAIL wedged in build", () => {
	it("is wedged: the FAIL folded the task into build and names no pair", () => {
		expect(leafOf(WEDGED)).toBe("build");
		const parsed = parseLog(WEDGED);
		if (parsed._tag !== "Parsed") throw new Error("the fixture does not parse");
		expect(standingIntegrateFailure(parsed.entries, TASK)).toBeNull();
	});

	it("appends one CORRECTED line carrying the pair, every recorded byte kept", async () => {
		const fs = ledger(WEDGED);

		const out = await run(fs);

		expect(out.code).toBe(0);
		expect(JSON.parse(out.stdout)).toEqual({
			lane: EPIC,
			task: TASK,
			event: `${TASK.toUpperCase()}.CORRECTED`,
			corrects: at(3),
			integrate: {exit: 43, head: HEAD},
		});
		const written = fs.written.get(LOG) ?? "";
		expect(written.startsWith(WEDGED)).toBe(true);
		expect(JSON.parse(written.slice(WEDGED.length))).toEqual({
			task: TASK,
			event: `${TASK.toUpperCase()}.CORRECTED`,
			at: NOW,
			corrects: at(3),
			integrate: {exit: 43, head: HEAD},
		});
	});

	it("leaves the task where it stood and makes the FAIL read as a standing integrate FAIL", async () => {
		const fs = ledger(WEDGED);
		await run(fs, {exit: 42});
		const written = fs.written.get(LOG) ?? "";

		expect(leafOf(written)).toBe("build");
		const parsed = parseLog(written);
		if (parsed._tag !== "Parsed") throw new Error("the attached log does not parse");
		const resolved = applyCorrections(parsed.entries);
		if (resolved._tag !== "Corrected") throw new Error("the correction does not resolve");
		expect(standingIntegrateFailure(resolved.entries, TASK)).toEqual({exit: 42, head: HEAD});
	});
});

describe("lane attach-integrate — refusals leave the log byte-identical", () => {
	const refused = async (
		log: string,
		extra: Parameters<typeof run>[1],
		code: number,
		says: string,
	) => {
		const fs = ledger(log);
		const out = await run(fs, extra);
		expect(out.code).toBe(code);
		expect(out.stderr.at(-1)).toContain(says);
		expect(laneWrites(fs.written)).toEqual([]);
	};

	it("refuses a line that is not a FAIL", () =>
		refused(WEDGED, {at: at(2)}, INTEGRATE_EVIDENCE, "is a PASS, not an integrate FAIL"));

	it("refuses a FAIL out of review — not an integrate FAIL", () =>
		refused(
			`${line("WIP", at(0))}${line("DONE", at(1))}${line("FAIL", at(2))}`,
			{at: at(2)},
			INTEGRATE_EVIDENCE,
			'is out of "review", not an integrate FAIL',
		));

	it("refuses a FAIL a later DONE already answered", () =>
		refused(
			`${WEDGED}${line("DONE", at(4))}`,
			{},
			INTEGRATE_EVIDENCE,
			`was answered by the DONE at ${at(4)}`,
		));

	it("refuses an exit lane integrate never fails on", () =>
		refused(WEDGED, {exit: 45}, INTEGRATE_EVIDENCE, "is not one of lane integrate's FAIL exits"));

	it("refuses a head that is not a commit sha", () =>
		refused(WEDGED, {head: "epic/900"}, INTEGRATE_EVIDENCE, "is not a commit sha"));

	it("refuses a FAIL that already carries its own pair", () =>
		refused(
			`${line("WIP", at(0))}${line("DONE", at(1))}${line("PASS", at(2))}${line("FAIL", at(3), {integrate: {exit: 44, head: HEAD}})}`,
			{},
			INTEGRATE_EVIDENCE,
			"already carries its own pair",
		));

	it("refuses an `at` naming no line of the task", () =>
		refused(WEDGED, {at: at(9)}, INTEGRATE_EVIDENCE, "no recorded line"));

	it("refuses a task the lane does not hold", () =>
		refused(WEDGED, {task: "issue_1"}, TASK_UNKNOWN, 'task "issue_1" is not in'));
});
