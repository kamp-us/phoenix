import {describe, expect, it} from "vitest";
import {BOARD_VOCABULARY} from "../config/keys/board-vocabulary.ts";
import {INTAKE_LABEL} from "../graduate/emit-verb.ts";
import {SESSION_LABEL} from "../grill/session.ts";
import {AWAITING_RELEASE, KILL_LABEL, NEEDS_INFO, PLANNED} from "../labels.ts";
import {MAP_LABEL} from "../map/frontier.ts";
import {FLIP_LABELS} from "../plan/digest.ts";
import {SPIKE_LABEL} from "../spike/bodies.ts";
import {READY_FOR_AGENT} from "../triage/audience.ts";
import {DEFAULT_QUEUE_LABEL} from "../triage/queue-verb.ts";
import {QUEUE_LABEL} from "../triage/split-verb.ts";
import {declaredBoard, SHIPPED_BOARD} from "./board.test-support.ts";
import {BUILDABLE_SURFACES, labelSurface} from "./bootstrap-verb.ts";
import {missingLabelRemedy} from "./label-remedy.ts";

/**
 * Every fixed label a verb refuses on when the repo lacks it, keyed by the verb that refuses. A verb
 * that starts refusing on a new fixed label belongs here, so a label no bootstrap creates fails this
 * suite rather than a fresh repo's first run.
 */
const REFUSED_WHEN_MISSING: ReadonlyArray<readonly [string, string]> = [
	["ledger child", PLANNED],
	["ledger adopt", PLANNED],
	...FLIP_LABELS.map((label) => ["plan flip", label] as const),
	["plan flip", READY_FOR_AGENT],
	["decision rule", READY_FOR_AGENT],
	["triage kill", KILL_LABEL],
	["triage park", NEEDS_INFO],
	["triage queue", DEFAULT_QUEUE_LABEL],
	["triage split", QUEUE_LABEL],
	["graduate emit", INTAKE_LABEL],
	["ship release", AWAITING_RELEASE],
	["grill open", SESSION_LABEL],
	["map open", MAP_LABEL],
	["spike open", SPIKE_LABEL],
];

const board = (read: typeof SHIPPED_BOARD) => {
	if (read._tag !== "Resolved") throw new Error(`board refused: ${read.reason}`);
	return read.resolved.board;
};

describe("every label a verb refuses on as missing is one some bootstrap surface creates", () => {
	it.each(REFUSED_WHEN_MISSING)("%s: %s", (_verb, label) => {
		expect(labelSurface(label, board(SHIPPED_BOARD))).not.toBeNull();
	});

	it("puts closed-by-triage in the label taxonomy", () => {
		expect(labelSurface(KILL_LABEL, board(SHIPPED_BOARD))).toBe("label-taxonomy");
	});

	it("answers the surfaces the hand-written grill, map, spike and ship refusals name", () => {
		const shipped = board(SHIPPED_BOARD);
		expect(labelSurface(SESSION_LABEL, shipped)).toBe("issue-shape-markers");
		expect(labelSurface(MAP_LABEL, shipped)).toBe("issue-shape-markers");
		expect(labelSurface(SPIKE_LABEL, shipped)).toBe("issue-shape-markers");
		expect(labelSurface(AWAITING_RELEASE, shipped)).toBe("label-taxonomy");
	});

	it("names only surfaces the registry can build", () => {
		const ids = new Set(BUILDABLE_SURFACES.map((surface) => surface.id));
		for (const [, label] of REFUSED_WHEN_MISSING) {
			expect(ids.has(labelSurface(label, board(SHIPPED_BOARD)) ?? "")).toBe(true);
		}
	});
});

describe("labelSurface reads the board it is handed", () => {
	const declared = declaredBoard({[BOARD_VOCABULARY]: {priorities: ["sev1", "sev2"]}});

	it("answers a declared label with the surface that creates it on that board", () => {
		expect(labelSurface("sev1", board(declared))).toBe("label-taxonomy");
	});

	it("answers a shipped default the declared board replaced with no surface", () => {
		expect(labelSurface("p1", board(declared))).toBeNull();
	});
});

describe("missingLabelRemedy", () => {
	it("names the exact bootstrap command for a label a surface creates", () => {
		expect(missingLabelRemedy(PLANNED, SHIPPED_BOARD)).toBe(
			"Run `fabrika status bootstrap label-taxonomy` to create it, then re-run.",
		);
		expect(missingLabelRemedy(MAP_LABEL, SHIPPED_BOARD)).toBe(
			"Run `fabrika status bootstrap issue-shape-markers` to create it, then re-run.",
		);
	});

	it("says plainly when no surface creates the label", () => {
		expect(missingLabelRemedy("lane:ops", SHIPPED_BOARD)).toBe(
			"No `fabrika status bootstrap` surface creates lane:ops — create it by hand, then re-run.",
		);
	});

	it("reads a refused board as UNKNOWN, never as the shipped default's answer", () => {
		const refused = declaredBoard({[BOARD_VOCABULARY]: 5});
		expect(refused._tag).toBe("Refused");
		expect(missingLabelRemedy(PLANNED, refused)).toMatch(/^Which .* is UNKNOWN — /);
	});
});
