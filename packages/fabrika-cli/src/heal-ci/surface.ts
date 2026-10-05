/**
 * The check-surface comparison: what a base branch **declares** required against what actually
 * **produces** a run at a head.
 *
 * One module because `heal-ci surface` and `heal-ci diagnose`'s arm 3 must not be able to disagree —
 * two derivations of one predicate are two answers to one question.
 *
 * The declared read itself moved to `../review/blocking.ts` when it became the blocking authority
 * every head-reading verb consults; it is re-exported here so this group's own callers keep one
 * import, and the permission split it carries is the load-bearing part: both of its reads, the
 * branch's rules and the branch record's protection summary, answer at contents-level scope, so a
 * 401 or 403 on either is a token that cannot see the surface, never a branch that declares nothing.
 * `GET /branches/{base}/protection` is not read: it needs the Administration permission, which a
 * workflow's `GITHUB_TOKEN` can never hold, so it answers that token `403`. Collapsing `unprobeable` into `no-requirements` would tell an adopter their repo gates nothing
 * when it may gate everything.
 */
import {isInformational} from "../review/rollup.ts";
import type {ShipCheckRun} from "../ship/github.ts";

export {type DeclaredRead, readDeclared} from "../review/blocking.ts";

export type SurfaceToken = "covered" | "gap" | "no-requirements" | "unprobeable";

export interface RequiredRow {
	readonly name: string;
	readonly state: "producing" | "absent";
}

export interface SurfaceComparison {
	readonly token: SurfaceToken;
	readonly required: ReadonlyArray<RequiredRow>;
	readonly extra: ReadonlyArray<string>;
	/** Declared contexts that have a producing run — so `producing <= required`, always. */
	readonly producing: number;
}

/** The declared set, however it was read, against the gating runs at one head. */
export const compare = (
	declared: ReadonlyArray<string>,
	runs: ReadonlyArray<ShipCheckRun>,
): SurfaceComparison => {
	const gating = runs.filter((run) => !isInformational(run.name)).map((run) => run.name);
	const produced = new Set(gating);
	const declaredSet = new Set(declared);
	const required = [...declaredSet].map(
		(name): RequiredRow => ({name, state: produced.has(name) ? "producing" : "absent"}),
	);
	const extra = [...produced].filter((name) => !declaredSet.has(name));
	const producing = required.filter((row) => row.state === "producing").length;
	const token: SurfaceToken =
		declaredSet.size === 0 ? "no-requirements" : producing < declaredSet.size ? "gap" : "covered";
	return {token, required, extra, producing};
};
