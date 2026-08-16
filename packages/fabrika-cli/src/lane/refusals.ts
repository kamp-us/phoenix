/**
 * The two refusal folds every `lane` verb shares, so a load or replay fault seats on the same code
 * with the same stderr shape whichever verb hit it.
 */
import {refuse, type VerbOutcome} from "../verb.ts";
import {LANE_ABSENT, LANE_UNREADABLE, MALFORMED_RECORD} from "./codes.ts";
import type {FoldResult} from "./fold.ts";
import type {LoadedLane} from "./store.ts";

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
