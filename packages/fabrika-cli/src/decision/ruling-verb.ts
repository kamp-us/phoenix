/**
 * `decision ruling` reports the ruling resolved by `./ruling.ts`, which checks the author
 * against the live roster on every read. See `decision ruling --help` for reported states.
 * `build claim` enforces admission from its own fresh read.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {badNumber, resolveTargetRepo} from "../build/target.ts";
import {listComments} from "../io/issues.ts";
import {controlPlaneRoster} from "../ship/roster.ts";
import {READY_FOR_AGENT, READY_FOR_HUMAN} from "../triage/audience.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {bodyDigest} from "./digest.ts";
import {requireDecision, scanRulings, stateOf} from "./ruling.ts";

const VERB = "decision ruling";

export interface RulingOptions {
	readonly number: number;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export const runRuling = (
	options: RulingOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const bad = badNumber(VERB, "an issue number", options.number);
		if (bad !== null) return bad;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const target = yield* requireDecision(VERB, repo, options.number);
		if (target._tag === "Refused") return target.outcome;

		const roster = yield* controlPlaneRoster(repo);
		if (roster._tag === "Unknown") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${roster.reason} — who may rule is unread, so the ruling state is UNKNOWN, not absent.`,
			);
		}

		const listed = yield* listComments(repo, options.number);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the comments on #${options.number}: ${listed.reason} — the ruling state is UNKNOWN, not absent.`,
			);
		}

		const derived = bodyDigest(target.issue.body);
		const scan = scanRulings(listed.value, options.number, roster.logins);
		const state = stateOf(scan, options.number, derived);
		const audience = target.issue.labels.includes(READY_FOR_AGENT)
			? READY_FOR_AGENT
			: target.issue.labels.includes(READY_FOR_HUMAN)
				? READY_FOR_HUMAN
				: null;

		return answer(
			JSON.stringify({
				answer: "ruling",
				issue: options.number,
				state,
				by: scan.standing?.by ?? null,
				markerDigest: scan.standing?.ruling.digest ?? null,
				derivedDigest: derived,
				ruling: scan.standing?.ruling.ruling ?? null,
				at: scan.standing?.ruling.at ?? null,
				comment: scan.standing?.comment ?? null,
				audience,
				disregarded: scan.disregarded,
				unauthorized: scan.unauthorized,
			}),
			[
				`${VERB}: ${roster.logins.size} control-plane account(s) from ${roster.owners.join(", ") || "no owner"} at ${roster.ref}.`,
				`${VERB}: read ${listed.value.length} comment(s) on #${options.number}; ${scan.disregarded} disregarded marker(s), ${scan.unauthorized} from an account off that roster.`,
			],
		);
	});
