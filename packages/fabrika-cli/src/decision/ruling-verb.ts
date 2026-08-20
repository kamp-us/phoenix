/**
 * `decision ruling` — report whether a decision issue carries a current founder ruling.
 *
 * **A reporting surface, never an enforcement.** It exits `0` on `absent` exactly as it does on
 * `current`, because a missing ruling is this verb's *answer*. What keeps an unruled decision out of
 * a build lane is `build claim`'s own type axis, which admits a decision only on a `--cites` naming a
 * ruling comment (ADR 0300) — that fence re-reads the board rather than trusting this report.
 *
 * **What `current` is safe to be read as.** A marker whose author the control-plane roster resolves
 * *at this read* — the author gate lives here, in the read, not only in `decision rule`'s write,
 * because bytes carrying the right digest can reach the issue from any account that can comment on
 * it.
 *
 * Both digests are printed, the marker's and the freshly derived one, so a `stale` answer shows what
 * moved rather than asserting that something did.
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
