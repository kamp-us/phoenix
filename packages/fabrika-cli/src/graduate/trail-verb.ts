/**
 * `graduate trail` normalizes one source through its sibling reader.
 * See `graduate trail --help` for readiness and refusal details.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveRepo} from "../io/issues.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {deriveTrail, requireSource} from "./source.ts";

export interface TrailOptions {
	readonly source: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const VERB = "graduate trail";

export const runTrail = (
	options: TrailOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const {source} = options;
		if (!Number.isInteger(source) || source <= 0) {
			return refuse(FAILED, `${VERB}: ${source} is not an issue number.`);
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				`${VERB}: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.`,
			);
		}
		const repo = repoAttempt.value;

		const found = yield* requireSource(VERB, repo, source, " — there is no trail to read.");
		if (found._tag === "Refused") return found.outcome;

		const resolved = yield* deriveTrail(VERB, repo, source, found.value.kind, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;

		const {trail, scope} = resolved.value;
		return answer(JSON.stringify(trail), [
			scope,
			`${VERB}: readiness "${trail.readiness}" over ${trail.counts.ruled} ruled, ${trail.counts.established} established and ${trail.counts.unresolved} unresolved.`,
		]);
	});
