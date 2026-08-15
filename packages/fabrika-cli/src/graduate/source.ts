/**
 * The source dispatch, and the trail derived through the sibling that owns it.
 *
 * Two verbs need the identical answer — `graduate trail` prints it and `graduate emit` re-derives it
 * to bind a spec — so it is resolved once here rather than twice beside them.
 *
 * **The resolution runs through the siblings' own readers and parses neither artifact.** A session
 * goes through `../grill/read-verb.ts`, whose four ruling clauses and ACL resolution are what `ruled`
 * *means*; a map goes through `../map/frontier.ts` and `../map/body.ts`, the module rather than `map
 * read`'s stdout, because that verb's answer carries no `## Decisions` array and a design reading
 * decisions off it could not produce a `ruled` row at all. A second parser here would be a second
 * answer to a question already decided elsewhere, and the two could disagree.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {runRead as runGrillRead} from "../grill/read-verb.ts";
import {SESSION_LABEL} from "../grill/session.ts";
import {getIssue, type IssueRecord} from "../io/issues.ts";
import {MAP_LABEL, readFrontier, readMap} from "../map/frontier.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {BAD_SECTIONS, NO_TARGET, PRECONDITION_UNKNOWN, SOURCE_UNRECOGNIZED} from "./codes.ts";
import {
	fromMap,
	fromSession,
	type ResolvedQuestion,
	type SourceKind,
	type Trail,
	trailOf,
} from "./trail.ts";

export type Guarded<A> =
	| {readonly _tag: "Ok"; readonly value: A}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

const refused = (outcome: VerbOutcome): Guarded<never> => ({_tag: "Refused", outcome});

export interface Source {
	readonly issue: IssueRecord;
	readonly kind: SourceKind;
}

/**
 * The source issue and which trail surface it is.
 *
 * An issue carrying **both** labels is `12` naming both rather than a merge of two trails: that is a
 * mis-shaped artifact, and guessing which one is live would be judgment inside a verb.
 */
export const requireSource = (
	verb: string,
	repo: string,
	source: number,
): Effect.Effect<Guarded<Source>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const found = yield* getIssue(repo, source);
		if (found._tag === "Absent") {
			return refused(refuse(NO_TARGET, `${verb}: #${source} does not exist.`));
		}
		if (found._tag === "Unknown") {
			return refused(
				refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read #${source}: ${found.reason} — the trail is UNKNOWN, never empty and never ready.`,
				),
			);
		}
		const isSession = found.value.labels.includes(SESSION_LABEL);
		const isMap = found.value.labels.includes(MAP_LABEL);
		if (isSession && isMap) {
			return refused(
				refuse(
					SOURCE_UNRECOGNIZED,
					`${verb}: #${source} carries both ${SESSION_LABEL} and ${MAP_LABEL} — refusing to guess which trail is live.`,
				),
			);
		}
		if (!isSession && !isMap) {
			return refused(
				refuse(
					SOURCE_UNRECOGNIZED,
					`${verb}: #${source} carries neither ${SESSION_LABEL} nor ${MAP_LABEL} — there is no trail to read.`,
				),
			);
		}
		return {_tag: "Ok", value: {issue: found.value, kind: isSession ? "grilling" : "map"}};
	});

/** What the dispatched resolver reported, for the scope line the readiness is only readable against. */
export interface Resolved {
	readonly trail: Trail;
	readonly scope: string;
}

/**
 * The grilling resolver's own refusal, re-seated under this verb's name.
 *
 * The ACL branch is discriminated off the sibling's message because its two `11`s mean different
 * things to a reader — a comment read that did not complete, versus a ruling whose authority could
 * not be resolved — and only the resolver knows which it hit. A miss lands on the general `11`, the
 * same code with a less specific reason, never a permissive answer.
 */
const grillRefusal = (verb: string, source: number, outcome: VerbOutcome): VerbOutcome => {
	const reason = outcome.stderr.at(-1) ?? "the resolver refused without a reason";
	if (outcome.code === NO_TARGET) {
		return refuse(NO_TARGET, `${verb}: #${source} does not exist.`);
	}
	return /'s permission on /.test(reason)
		? refuse(
				PRECONDITION_UNKNOWN,
				`${verb}: the resolver could not resolve a marker author's permission: ${reason} — a ruling's authority is UNKNOWN, never granted.`,
			)
		: refuse(
				PRECONDITION_UNKNOWN,
				`${verb}: cannot read #${source}: ${reason} — the trail is UNKNOWN, never empty and never ready.`,
			);
};

interface GrillAnswer {
	readonly questions: ReadonlyArray<ResolvedQuestion>;
	readonly frontier: string;
	readonly scanned: Readonly<Record<string, number>>;
}

/**
 * The trail of `source`, resolved through the reader its kind belongs to.
 *
 * Zero decisions is a **fact** — the trail reads `empty`. A read that could not complete is `11`,
 * never an empty trail (ADR 0092).
 */
export const deriveTrail = (
	verb: string,
	repo: string,
	source: number,
	kind: SourceKind,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Guarded<Resolved>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		if (kind === "grilling") {
			const outcome = yield* runGrillRead({session: source, repo, env});
			if (outcome.code !== 0) return refused(grillRefusal(verb, source, outcome));
			const answer = JSON.parse(outcome.stdout) as GrillAnswer;
			const normalized = fromSession(answer.questions);
			return {
				_tag: "Ok",
				value: {
					trail: trailOf({source, kind, ...normalized, outOfScope: []}),
					scope: `${verb}: #${source} is a grilling session; the resolver read ${answer.scanned.comments ?? 0} comment(s) over ${answer.scanned.rounds ?? 0} round(s) and reports frontier "${answer.frontier}".`,
				},
			};
		}

		const map = yield* readMap(repo, source);
		if (map._tag === "Absent") {
			return refused(refuse(NO_TARGET, `${verb}: #${source} does not exist.`));
		}
		if (map._tag === "Malformed") {
			return refused(
				refuse(
					BAD_SECTIONS,
					`${verb}: #${source}'s map body does not parse into the five sections, or holds a ## Decisions entry citing neither an authority nor a ticket (${map.reason}) — this is proven malformed, not unknown. Fix the map and re-run.`,
				),
			);
		}
		if (map._tag === "Unknown") {
			return refused(
				refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read #${source}: ${map.reason} — the trail is UNKNOWN, never empty and never ready.`,
				),
			);
		}

		const frontier = yield* readFrontier(repo, source, map.body);
		if (frontier._tag !== "Frontier") {
			return refused(
				refuse(
					PRECONDITION_UNKNOWN,
					`${verb}: cannot read #${source}: ${frontier._tag === "MapAbsent" ? "the map reports no child list" : frontier.reason} — the trail is UNKNOWN, never empty and never ready.`,
				),
			);
		}

		const normalized = fromMap(map.body.decisions, frontier.value.tickets);
		return {
			_tag: "Ok",
			value: {
				trail: trailOf({source, kind, ...normalized, outOfScope: map.body.outOfScope}),
				scope: `${verb}: #${source} is a wayfinding map; the resolver read ${frontier.value.scanned.children} child(ren) and ${frontier.value.scanned.comments} comment(s), and the body carries ${map.body.decisions.length} decision(s).`,
			},
		};
	});
