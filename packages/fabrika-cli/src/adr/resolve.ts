/**
 * `adr resolve`'s state resolution, pure.
 *
 * All four states are answers and every one is a positive token: `absent` on exit 0 means *proven
 * absent against a current tree* — the fetch succeeded, the records were read, the open pull
 * requests were enumerated, and no one holds this id. It is never what a failed read prints; a
 * failed read exits 11, 17 or 18 with nothing on stdout.
 */
import {isLive} from "./records.ts";

/** A record present on the fetched base ref. */
export interface MergedRecord {
	readonly id: string;
	readonly file: string;
	/** The frontmatter `status:` value, verbatim. */
	readonly status: string;
}

/** A record an open pull request adds but the base ref does not carry. */
export interface InFlightRecord {
	readonly id: string;
	readonly file: string;
	readonly pr: number;
}

export type State = "live" | "landed" | "in-flight" | "absent";

export interface Resolution {
	readonly id: string;
	readonly state: State;
	readonly file: string;
	readonly detail: string;
}

/** Two records on the base ref claiming one id — a refusal, since neither can be *the* record. */
export interface DuplicateId {
	readonly id: string;
	readonly files: readonly [string, string];
}

/**
 * Index the base-ref records by id, or report the first duplicate.
 *
 * A duplicate is impossible to answer honestly — `live`/`landed` name *the* file for an id — so it
 * is surfaced as a refusal rather than resolved by picking one.
 */
export const indexMerged = (
	records: ReadonlyArray<MergedRecord>,
): {readonly index: ReadonlyMap<string, MergedRecord>} | {readonly duplicate: DuplicateId} => {
	const index = new Map<string, MergedRecord>();
	for (const record of records) {
		const seen = index.get(record.id);
		if (seen !== undefined) {
			return {duplicate: {id: record.id, files: [seen.file, record.file]}};
		}
		index.set(record.id, record);
	}
	return {index};
};

/**
 * Index in-flight records by id. Two open pull requests claiming one id is a live race rather than
 * a broken tree, so it resolves deterministically to the lowest pull request number — the caller's
 * own `adr next` re-check is what catches the race for its own id.
 */
export const indexInFlight = (
	records: ReadonlyArray<InFlightRecord>,
): ReadonlyMap<string, InFlightRecord> => {
	const index = new Map<string, InFlightRecord>();
	for (const record of records) {
		const seen = index.get(record.id);
		if (seen === undefined || record.pr < seen.pr) index.set(record.id, record);
	}
	return index;
};

/** Resolve one id against the base-ref and in-flight indexes. */
export const resolveId = (
	id: string,
	merged: ReadonlyMap<string, MergedRecord>,
	inFlight: ReadonlyMap<string, InFlightRecord>,
): Resolution => {
	const landed = merged.get(id);
	if (landed !== undefined) {
		return {
			id,
			state: isLive(landed.status) ? "live" : "landed",
			file: landed.file,
			detail: landed.status,
		};
	}
	const open = inFlight.get(id);
	if (open !== undefined) {
		return {id, state: "in-flight", file: open.file, detail: `PR #${open.pr}`};
	}
	return {id, state: "absent", file: "-", detail: "-"};
};

/** The line grammar: one tab-separated `<state>\t<file>\t<detail>` row per id, in argument order. */
export const renderResolution = (r: Resolution): string => `${r.state}\t${r.file}\t${r.detail}`;
