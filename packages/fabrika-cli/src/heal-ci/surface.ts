/**
 * The check-surface comparison: what a base branch **declares** required against what actually
 * **produces** a run at a head.
 *
 * One module because `heal-ci surface` and `heal-ci diagnose`'s arm 3 must not be able to disagree —
 * two derivations of one predicate are two answers to one question.
 *
 * The permission split is the load-bearing part and it was **probed live** rather than assumed:
 * `GET /branches/{base}/protection` answers `404 "Branch not protected"` both when a branch has no
 * protection and when the token cannot see it, so a 404 alone is evidence of nothing; the rules read
 * answers at ordinary `repo` scope and is what carries the answer. Collapsing `unprobeable` into
 * `no-requirements` would tell an adopter their repo gates nothing when it may gate everything.
 */
import {Effect} from "effect";
import type {Shell} from "../io/git.ts";
import {isInformational} from "../review/rollup.ts";
import type {ShipCheckRun} from "../ship/github.ts";
import {branchProtectionContexts, rulesetContexts} from "./github.ts";

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

export type DeclaredRead =
	/** The declared set is known, however many members it has. */
	| {readonly _tag: "Declared"; readonly contexts: ReadonlyArray<string>; readonly scanned: number}
	/** The token cannot see the protection surface — an answer at exit `0`, never `no-requirements`. */
	| {readonly _tag: "Unprobeable"; readonly reason: string}
	/** The rules enumeration completed and is provably short of a terminal page. */
	| {readonly _tag: "Incomplete"; readonly scanned: number}
	/** A read failed for a reason that is not this token's permission — coverage is UNKNOWN. */
	| {readonly _tag: "Unknown"; readonly what: string; readonly reason: string};

const isPermissionDenial = (status: number | null): boolean => status === 401 || status === 403;

/**
 * The declared required contexts for one base branch: branch protection ∪ the rulesets that match it.
 *
 * `no-requirements` needs a **successful** rules read returning zero required contexts *and* the
 * protection endpoint's 404 — both, never the 404 alone.
 */
export const readDeclared = (repo: string, base: string): Shell<DeclaredRead> =>
	Effect.gen(function* () {
		const rules = yield* rulesetContexts(repo, base);
		if (rules._tag === "Failure") {
			return isPermissionDenial(rules.status)
				? {_tag: "Unprobeable" as const, reason: rules.reason}
				: {_tag: "Unknown" as const, what: "the ruleset list", reason: rules.reason};
		}
		if (!rules.value.exhausted) {
			return {_tag: "Incomplete" as const, scanned: rules.value.scanned};
		}

		const {read: protection, status} = yield* branchProtectionContexts(repo, base);
		if (protection._tag === "Unknown") {
			return isPermissionDenial(status)
				? {_tag: "Unprobeable" as const, reason: protection.reason}
				: {_tag: "Unknown" as const, what: "the branch protection", reason: protection.reason};
		}
		const fromProtection = protection._tag === "Present" ? protection.value : [];
		return {
			_tag: "Declared" as const,
			contexts: [...new Set([...fromProtection, ...rules.value.contexts])],
			scanned: rules.value.scanned,
		};
	});
