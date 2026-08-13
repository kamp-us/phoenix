/**
 * `heal-ci surface` — declared required contexts against the runs that actually post at a head.
 *
 * **This verb changes nothing.** Arming, renaming and disarming a required context are repository
 * settings changes with a human's name on them, and #3377 is what arming one wrong costs: the entire
 * merge queue wedged. It diagnoses and stops.
 *
 * `extra` rows are reported, never judged — a gating run answering no requirement is normal, and
 * printing both sides is what lets a reader see which of the two mistakes they have.
 */
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {commitExists} from "../io/pulls.ts";
import {latestPerContext, listShipCheckRuns} from "../ship/github.ts";
import {
	badNumber,
	inspectedSha,
	NULL_TOKEN,
	prefixMatch,
	resolvePull,
	resolveTargetRepo,
} from "../ship/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {compare, readDeclared} from "./surface.ts";

const VERB = "heal-ci surface";

export interface SurfaceOptions {
	readonly pr: number;
	readonly sha: string;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runSurface = (
	options: SurfaceOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "a pull-request number", options.pr);
		if (bad !== null) return bad;
		if (options.sha !== "") {
			const checked = inspectedSha(VERB, options.sha);
			if (typeof checked !== "string") return checked;
		}

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;
		const pr = options.pr;

		const unreadable = (what: string, reason: string): string =>
			`${VERB}: cannot read ${what} for ${repo}: ${reason} — coverage is UNKNOWN, never "no-requirements".`;

		const target = yield* resolvePull(VERB, repo, pr, {
			unknownMessage: (reason) => unreadable("the pull request", reason),
		});
		if (target._tag === "Refused") return target.outcome;
		const pull = target.pull;

		const bound = options.sha === "" ? pull.headSha : options.sha;
		if (options.sha !== "") {
			const at = yield* commitExists(repo, bound);
			if (at._tag === "Absent") {
				return refuse(ZERO_SCOPE, `${VERB}: no commit ${bound} on PR #${pr}.`);
			}
			if (at._tag === "Unknown") {
				return refuse(PRECONDITION_UNKNOWN, unreadable("the commit", at.reason));
			}
		}

		const notices: string[] = [];
		if (!prefixMatch(pull.headSha, bound)) {
			notices.push(
				`${VERB}: the live head is ${pull.headSha}, you are enumerating ${bound} — the head moved.`,
			);
		}

		const enumerated = yield* listShipCheckRuns(repo, bound);
		if (enumerated._tag === "Failure") {
			return refuse(PRECONDITION_UNKNOWN, unreadable("the check runs", enumerated.reason), notices);
		}
		if (enumerated.value.runs.length < enumerated.value.declared) {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: received ${enumerated.value.runs.length} of ${enumerated.value.declared} declared check runs — refusing to compare a truncated set.`,
				notices,
			);
		}
		const runs = latestPerContext(enumerated.value.runs);

		const declared = yield* readDeclared(repo, pull.baseRef);
		if (declared._tag === "Unknown") {
			return refuse(PRECONDITION_UNKNOWN, unreadable(declared.what, declared.reason), notices);
		}
		if (declared._tag === "Incomplete") {
			return refuse(
				INCOMPLETE_SCAN,
				`${VERB}: the ruleset read never reached a terminal page — refusing to compare a truncated set.`,
				notices,
			);
		}

		if (declared._tag === "Unprobeable") {
			// The declared set is unknown, so the counts it would divide are unknown too — printing a
			// number here is the collapse into `no-requirements` this token exists to prevent.
			const comparison = compare([], runs);
			notices.push(
				`${VERB}: cannot read ${pull.baseRef}'s protection surface at this token's permission — the check-surface axis is UNPROBEABLE, never "no requirements".`,
			);
			return options.json
				? answer(
						JSON.stringify({
							outcome: "unprobeable",
							sha: bound,
							required: null,
							extra: comparison.extra,
							counts: {required: null, producing: null, extra: comparison.extra.length},
						}),
						notices,
					)
				: answer(
						[
							`surface\tunprobeable\t${bound}`,
							...comparison.extra.map((name) => `extra\t${name}`),
							`facts\trequired:${NULL_TOKEN}\tproducing:${NULL_TOKEN}\textra:${comparison.extra.length}`,
						].join("\n"),
						notices,
					);
		}

		const comparison = compare(declared.contexts, runs);
		if (comparison.token === "no-requirements") {
			notices.push(
				`${VERB}: ${pull.baseRef} declares no required status contexts — this repository gates nothing on ${pull.baseRef}.`,
			);
		}

		return options.json
			? answer(
					JSON.stringify({
						outcome: comparison.token,
						sha: bound,
						required: comparison.required.map((row) => ({name: row.name, state: row.state})),
						extra: comparison.extra,
						counts: {
							required: comparison.required.length,
							producing: comparison.producing,
							extra: comparison.extra.length,
						},
					}),
					notices,
				)
			: answer(
					[
						`surface\t${comparison.token}\t${bound}`,
						...comparison.required.map((row) => `required\t${row.name}\t${row.state}`),
						...comparison.extra.map((name) => `extra\t${name}`),
						`facts\trequired:${comparison.required.length}\tproducing:${comparison.producing}\textra:${comparison.extra.length}`,
					].join("\n"),
					notices,
				);
	});
