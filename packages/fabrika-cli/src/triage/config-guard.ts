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
import {CONFIG_PATH} from "../config/document.ts";
import {unusableReason} from "../config/unusable.ts";
import {loadRepoConfig} from "../config/working-root.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {CONFIG_REFUSED} from "./codes.ts";

/**
 * The refusal this repo's config earns, or `null` when every key of it decoded.
 *
 * `null` is not "the config is absent" — an absent file loads to the shipped defaults, which is the
 * ordinary case and passes here like any other conforming config. It is also not "the load raised no
 * refusal": a file that could not be read, or that no decoder accepted, is a config this verb has no
 * containment answer for, and `../config/unusable.ts` is what keeps those out of the write path.
 */
export const configRefusal = (
	verb: string,
	cwd: string,
): Effect.Effect<VerbOutcome | null, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const load = yield* loadRepoConfig(cwd);
		const unusable = unusableReason(load);
		if (unusable === null) return null;
		// Each key words its own refusal, and they do not agree about a final period.
		const reason = unusable.replace(/\.$/, "");
		return refuse(
			CONFIG_REFUSED,
			`${verb}: ${CONFIG_PATH} is refused — ${reason}. Nothing was written; fix the config, because every label this verb would reconcile is judged against it.`,
		);
	});
