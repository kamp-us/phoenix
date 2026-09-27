/**
 * What the `tuval` command does, decided from what it was asked and what it found (#9696, ruling
 * #9668 R6.1). `tuval` starts a desk or brings the running one forward; `tuval open <folder>` adds
 * a project to the running desk, like `code .`, or starts a desk with that project open. A stale
 * record is never a running desk: the new desk replaces it.
 */

import type {DeskRecord} from "./record.ts";
import type {DeskSighting} from "./sighting.ts";

/**
 * What the person asked for. `project` is the folder a new desk opens first, and `startFlags` says
 * whether any flag that only shapes a new desk was given.
 */
export type DeskRequest =
	| {readonly _tag: "Show"; readonly project: string; readonly startFlags: boolean}
	| {readonly _tag: "Open"; readonly folder: string};

/** A stale record the start is replacing: its reason, and whose record it was. */
export interface StaleRecord {
	readonly reason: string;
	readonly pid: number | null;
}

export type DeskAction =
	/** Boot a desk here with `project` as its first project, replacing `stale` if one was left. */
	| {readonly _tag: "Start"; readonly project: string; readonly stale: StaleRecord | null}
	/** Bring the running desk's page forward and start nothing; the start flags given go unused. */
	| {readonly _tag: "Forward"; readonly desk: DeskRecord; readonly startFlagsIgnored: boolean}
	/** Bring the running desk forward and ask it to open `folder`, trust prompt and all. */
	| {
			readonly _tag: "OpenIn";
			readonly desk: DeskRecord;
			readonly launchUrl: string;
			readonly folder: string;
	  };

export const decide = (request: DeskRequest, sighting: DeskSighting): DeskAction => {
	if (sighting._tag === "Live") {
		return request._tag === "Show"
			? {_tag: "Forward", desk: sighting.record, startFlagsIgnored: request.startFlags}
			: {
					_tag: "OpenIn",
					desk: sighting.record,
					launchUrl: sighting.launchUrl,
					folder: request.folder,
				};
	}
	const stale = sighting._tag === "Stale" ? {reason: sighting.reason, pid: sighting.pid} : null;
	const project = request._tag === "Show" ? request.project : request.folder;
	return {_tag: "Start", project, stale};
};
