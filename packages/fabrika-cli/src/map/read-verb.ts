/**
 * `map read` — the parser: five sections, one row per frontier ticket with a closed-set state, the
 * frontier token, and the body digest.
 *
 * <!-- anchor: READ-NEVER-REFUSES-ON-CONTENT --> **This verb never refuses on a ticket's content.** A
 * ticket whose marker is malformed, or whose kind is off-vocabulary, is reported in `disregarded` at
 * exit `0` — refusing would suppress the whole frontier over one bad comment and would let anyone
 * with write access disable the verb by filing one. See `map read --help` for refusal details.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {digestOfBody} from "./body.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {counts, frontierToken, readFrontier} from "./frontier.ts";
import {requireMap, targetRepo} from "./guards.ts";

export interface ReadOptions {
	readonly map: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const VERB = "map read";

export const runRead = (
	options: ReadOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const found = yield* requireMap(VERB, repo, options.map);
		if (found._tag === "Refused") return found.outcome;
		const {body} = found.value;

		const frontier = yield* readFrontier(repo, options.map, body);
		if (frontier._tag !== "Frontier") {
			return refuse(
				PRECONDITION_UNKNOWN,
				frontier._tag === "MapAbsent"
					? `${VERB}: cannot read #${options.map}'s children: the map reports no child list — the frontier is UNKNOWN, never empty.`
					: `${VERB}: cannot read #${options.map}'s children: ${frontier.reason} — the frontier is UNKNOWN, never empty.`,
			);
		}
		const {tickets, disregarded, scanned} = frontier.value;

		const scope = `${VERB}: ${repo}, ${scanned.children} child(ren), ${scanned.edgeReads} edge read(s), ${scanned.comments} comment(s) scanned.`;
		return answer(
			JSON.stringify({
				map: options.map,
				frontier: frontierToken(tickets),
				digest: digestOfBody(body),
				destination: body.destination,
				tickets,
				outOfScope: body.outOfScope,
				fog: body.fog,
				counts: counts(tickets),
				disregarded,
				scanned,
			}),
			[scope],
		);
	});
