/**
 * The refusal folds every `lane` verb shares, so a key, load, boot or replay fault seats on the same
 * code with the same stderr shape whichever verb hit it.
 */
import {refuse, type VerbOutcome} from "../verb.ts";
import {
	APPEND_UNKNOWN,
	KEY_MALFORMED,
	LANE_ABSENT,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
} from "./codes.ts";
import type {FoldResult} from "./fold.ts";
import type {KeyResult} from "./key.ts";
import type {LoadedLane, Placement} from "./store.ts";

/**
 * Seat an unreadable `lane` argument. Group-level rather than per-verb: the key is parsed by the
 * adapter every verb shares, before any of them is reached.
 */
export const keyRefusal = (malformed: Extract<KeyResult, {_tag: "Malformed"}>): VerbOutcome =>
	refuse(
		KEY_MALFORMED,
		`fabrika lane: "${malformed.raw}" is not a lane key — ${malformed.reason}. A key is an issue number, or \`chore:<name>\` for a chore lane.`,
	);

/** Seat a non-`Loaded` load outcome. Absent names the remedy: open the lane from a template. */
export const loadRefusal = (
	verb: string,
	loaded: Exclude<LoadedLane, {_tag: "Loaded"}>,
): VerbOutcome => {
	switch (loaded._tag) {
		case "Absent":
			return refuse(
				LANE_ABSENT,
				`${verb}: no lane at ${loaded.dir} — copy a workflow template to ${loaded.dir}/workflow.json to open it.`,
			);
		case "Unreadable":
			return refuse(
				LANE_UNREADABLE,
				`${verb}: cannot read ${loaded.path}: ${loaded.reason} — the lane state is UNKNOWN, never fresh.`,
			);
		case "Malformed":
			return refuse(
				MALFORMED_RECORD,
				`${verb}: ${loaded.path} was read in full and is not the shape.`,
				loaded.defects.map((defect) => `${verb}: defect: ${defect}`),
			);
	}
};

/**
 * One stderr sentence out of a refusal's own plus whatever the caller wrote before reaching it, so a
 * refusal that stranded something on the board says so in the same line rather than a stray one.
 */
export const say = (...sentences: ReadonlyArray<string>): string =>
	sentences.filter((sentence) => sentence.length > 0).join(" ");

/**
 * Seat a non-`Placed`, non-`Exists` boot outcome — nothing was written *to disk*, and the reason
 * names the remedy. `Exists` is not folded here: the two boot verbs answer it with opposite remedies
 * — `lane emit` retires and re-emits a lane running the wrong machine, `lane open` sends the driver
 * at the lane that is already there — so each states its own rather than sharing a sentence that is
 * true of one of them.
 *
 * `stranded` carries what the caller already landed off-disk before the placement refused — `lane
 * open --from-board`'s adoption comment is the one — because "nothing was booted" is true of the
 * ledger and false of the board, and a reader who meets only the first half meets a record nothing
 * accounts for.
 */
export const placementRefusal = (
	verb: string,
	placed: Exclude<Placement, {_tag: "Placed"} | {_tag: "Exists"}>,
	stranded: ReadonlyArray<string> = [],
): VerbOutcome => {
	switch (placed._tag) {
		case "Unprobeable":
			return refuse(
				LANE_UNREADABLE,
				say(
					`${verb}: cannot establish whether a lane is already at ${placed.dir}: ${placed.reason} — refusing to write over UNKNOWN.`,
					...stranded,
				),
			);
		case "Unwritten":
			return refuse(
				APPEND_UNKNOWN,
				say(
					`${verb}: the write to ${placed.path} did not land: ${placed.reason} — the lane is NOT booted.`,
					...stranded,
				),
			);
	}
};

/** Seat an unreplayable log — read in full, contradicting the machine. */
export const replayRefusal = (
	verb: string,
	logPath: string,
	fold: Exclude<FoldResult, {_tag: "Folded"}>,
): VerbOutcome =>
	refuse(
		MALFORMED_RECORD,
		`${verb}: ${logPath} was read in full and does not replay through this lane's machine.`,
		fold.defects.map((defect) => `${verb}: defect: ${defect}`),
	);
