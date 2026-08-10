/**
 * The governance-namespace derivation, as a pure function of one bound commit's changed paths.
 *
 * The root set is **not declared here**. `GOVERNANCE_ROOTS` and `touchesGovernanceRoot` live in
 * `../review/classes.ts`, where `ship scope` and `ship gate`'s required-set floor already read them,
 * and this module imports both — one derivation, three readers. Two derivations of one namespace are
 * two answers to one question (#4730), and the two would disagree the first time a fifth root landed
 * in only one of them.
 *
 * The directory is the unit of coverage, not the file type: an enumerated skill-dir list plus an
 * any-depth `*.sh` clause is what left a non-`.sh` file beside a gated script proven-ordinary in v1.
 */

import {idFromFile, isFourDigitId} from "../adr/records.ts";
import type {ChangedPath} from "../io/git.ts";
import {GOVERNANCE_ROOTS, touchesGovernanceRoot} from "../review/classes.ts";

/** One root and how many of the diff's paths sit under it. Only roots the diff touches are reported. */
export interface RootTally {
	readonly name: string;
	readonly files: number;
}

/** A decision record the diff carries, and what the diff does to it. */
export interface RecordChange {
	readonly id: string;
	readonly change: "added" | "modified" | "deleted";
	readonly path: string;
}

export interface ScopeResult {
	readonly required: boolean;
	readonly roots: ReadonlyArray<RootTally>;
	readonly self: boolean;
	readonly records: ReadonlyArray<RecordChange>;
	readonly scanned: number;
}

/**
 * git's change letter as this group's vocabulary.
 *
 * `deleted` is in the vocabulary because removing a decision record is itself a governance event —
 * the one change to the corpus an added/modified pair cannot express at all. A rename lands on
 * `added` because its `path` is the destination: the record now exists there and did not before.
 */
export const changeOf = (status: string): RecordChange["change"] => {
	if (status.startsWith("D")) return "deleted";
	if (status.startsWith("A") || status.startsWith("R") || status.startsWith("C")) return "added";
	return "modified";
};

/** The four-digit-addressable decision records among the changed paths, in path order. */
export const recordsIn = (changed: ReadonlyArray<ChangedPath>): ReadonlyArray<RecordChange> => {
	const out: RecordChange[] = [];
	for (const entry of changed) {
		const base = entry.path.split("/").pop() ?? "";
		const id = idFromFile(base);
		// A lettered variant (`0034a`) is a real record the corpus carries, but it is not addressable
		// by the four-digit `--record` these verbs take, so reporting it would name an id no sibling
		// verb accepts.
		if (id === null || !isFourDigitId(id)) continue;
		out.push({id, change: changeOf(entry.status), path: entry.path});
	}
	return out;
};

/**
 * Derive the namespace over one bound commit's changed paths.
 *
 * `skillRoots` is what the `<anything>/fabrika/skills/governance/SKILL.md` resolution found at the commit —
 * possibly none, possibly several. `self` is true when any changed path lies under **any** of them,
 * which is the conservative direction: an ambiguous install flags the self fence rather than
 * skipping it, and the fence is what stops a self-editing PR being judged by its own new rules
 * (ADR 0052).
 */
export const deriveScope = (
	changed: ReadonlyArray<ChangedPath>,
	skillRoots: ReadonlyArray<string>,
): ScopeResult => {
	const paths = changed.map((entry) => entry.path);
	return {
		required: touchesGovernanceRoot(paths),
		roots: GOVERNANCE_ROOTS.map((name) => ({
			name,
			files: paths.filter((path) => path.startsWith(name)).length,
		})).filter((tally) => tally.files > 0),
		self: paths.some((path) => skillRoots.some((root) => path.startsWith(root))),
		records: recordsIn(changed),
		scanned: paths.length,
	};
};
