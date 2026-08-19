/**
 * The load-time config gate both writing triage verbs run before anything else.
 *
 * `triage apply` and `triage park` write through one reconcile engine, and the containment invariant
 * that engine depends on is a property of the *loaded* config (`../config/containment.ts`). So the
 * gate sits at the top of each verb, ahead of the target read: a refused config is a refused config
 * whatever issue was named, and reading the board first would spend an API call to reach the same
 * answer.
 *
 * One module rather than two copies, for the reason the reconcile itself is one module — two
 * independently-written gates are two chances to disagree about what a refused config means.
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ResolvedBoard} from "../config/board.ts";
import {CONFIG_PATH} from "../config/document.ts";
import {resolveBoard} from "../config/resolve-board.ts";
import {unusableReason} from "../config/unusable.ts";
import {loadRepoConfig} from "../config/working-root.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {CONFIG_REFUSED} from "./codes.ts";
import {FACET_VOCABULARY} from "./facets.ts";

/**
 * The gate's two answers: the board this run reconciles against, or the refusal it owes.
 *
 * One shape rather than a `null`-for-ok predicate plus a second read, because the board and the
 * refusal come off the same load — and a verb that read the config twice could act on a file that
 * changed between the two reads.
 */
export type ConfigGate =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Ready"; readonly resolved: ResolvedBoard};

/**
 * The board this repo's config resolves to, or the refusal it earns.
 *
 * `Ready` is not "the config is absent" — an absent file loads to the shipped defaults, which is the
 * ordinary case and passes here like any other conforming config. `Refused` is not "the load raised
 * a refusal" either: a file that could not be read, or that no decoder accepted, is a config this
 * verb has no containment answer for, and `../config/unusable.ts` is what keeps those out of the
 * write path.
 */
export const guardConfig = (
	verb: string,
	cwd: string,
): Effect.Effect<ConfigGate, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const load = yield* loadRepoConfig(cwd);
		const unusable = unusableReason(load);
		if (unusable !== null) return {_tag: "Refused" as const, outcome: refusal(verb, unusable)};
		const board = resolveBoard(load, FACET_VOCABULARY);
		return board._tag === "Refused"
			? {_tag: "Refused" as const, outcome: refusal(verb, board.reason)}
			: {_tag: "Ready" as const, resolved: board.resolved};
	});

const refusal = (verb: string, reason: string): VerbOutcome =>
	refuse(
		CONFIG_REFUSED,
		// Each key words its own refusal, and they do not agree about a final period.
		`${verb}: ${CONFIG_PATH} is refused — ${reason.replace(/\.$/, "")}. Nothing was written; fix the config, because every label this verb would reconcile is judged against it.`,
	);
