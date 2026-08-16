/**
 * The two refusal folds every `lane` verb shares, so a load or replay fault seats on the same code
 * with the same stderr shape whichever verb hit it.
 */
import {refuse, type VerbOutcome} from "../verb.ts";
import {
	APPEND_UNKNOWN,
	LANE_ABSENT,
	LANE_EXISTS,
	LANE_UNREADABLE,
	MALFORMED_RECORD,
} from "./codes.ts";
import type {FoldResult} from "./fold.ts";
import type {LoadedLane, Placement} from "./store.ts";

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

/** Seat a non-`Placed` boot outcome — nothing was written, and the reason names the remedy. */
export const placementRefusal = (
	verb: string,
	placed: Exclude<Placement, {_tag: "Placed"}>,
): VerbOutcome => {
	switch (placed._tag) {
		case "Exists":
			return refuse(
				LANE_EXISTS,
				`${verb}: a lane already exists at ${placed.dir} — resuming needs no boot; remove the directory to rebuild it.`,
			);
		case "Unprobeable":
			return refuse(
				LANE_UNREADABLE,
				`${verb}: cannot establish whether a lane is already at ${placed.dir}: ${placed.reason} — refusing to write over UNKNOWN.`,
			);
		case "Unwritten":
			return refuse(
				APPEND_UNKNOWN,
				`${verb}: the write to ${placed.path} did not land: ${placed.reason} — the lane is NOT booted.`,
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
