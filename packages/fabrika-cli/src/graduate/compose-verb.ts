/**
 * `graduate compose` — render the four-section spec body, owning `## Decisions` entirely.
 *
 * Its answer channel is machine but not JSON: stdout is the composed markdown, byte-exact, ready to
 * hand to `graduate emit --spec`. The bytes are *fed to another command* rather than grepped for a
 * state word, and the four-section document is the declared shape.
 *
 * Two refusals are here rather than in skill prose, so they hold even when the skill's own step is
 * skipped: a `blocked` trail is `13` and an `empty` one is `16`. A spec can never be composed over a
 * decision nobody made.
 */

import {Effect} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	BAD_SECTIONS,
	BARE_AT_PATH,
	DECISIONS_AUTHORED,
	DIGEST_UNBINDABLE,
	EMPTY_STDIN,
	LEAKED_PATH,
	PRECONDITION_UNKNOWN,
	TRAIL_BLOCKED,
	TRAIL_EMPTY,
} from "./codes.ts";
import {
	AUTHORED_SECTIONS,
	carriesDecisionsHeading,
	checkSections,
	composeSpec,
	DECISIONS_SECTION,
	unplacedContent,
} from "./spec.ts";
import {parseTrailDocument} from "./trail.ts";

/** A document the adapter read off disk, as a value the verb branches on. */
export type DocumentRead =
	| {readonly _tag: "Text"; readonly text: string}
	| {readonly _tag: "Failed"; readonly reason: string};

export interface ComposeOptions<R = never> {
	readonly trailPath: string;
	readonly trail: Effect.Effect<DocumentRead, never, R>;
	/** One ref this spec covers, repeatable. Empty means every decision on the trail. */
	readonly decisions: ReadonlyArray<string>;
	readonly stdin: Effect.Effect<StdinRead>;
}

const VERB = "graduate compose";

export const runCompose = <R = never>(
	options: ComposeOptions<R>,
): Effect.Effect<VerbOutcome, never, R> =>
	Effect.gen(function* () {
		const read = yield* options.stdin;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`${VERB}: could not read stdin: ${read.reason} — the authored sections are UNKNOWN, never empty.`,
			);
		}
		const authored = read._tag === "NoStdin" ? "" : read.text;
		if (authored.trim() === "") {
			return refuse(
				EMPTY_STDIN,
				`${VERB}: stdin was read and held nothing — refusing to compose a spec with no authored sections.`,
			);
		}
		if (carriesDecisionsHeading(authored)) {
			return refuse(
				DECISIONS_AUTHORED,
				`${VERB}: stdin carries a "${DECISIONS_SECTION}" heading — that section is rendered from the trail, never authored.`,
			);
		}
		const problem = checkSections(authored, AUTHORED_SECTIONS);
		if (problem !== null) {
			return refuse(
				BAD_SECTIONS,
				problem._tag === "Missing"
					? `${VERB}: section "${problem.heading}" is missing.`
					: problem._tag === "Empty"
						? `${VERB}: section "${problem.heading}" is empty.`
						: `${VERB}: sections are out of order — "${problem.heading}" follows "${problem.after}".`,
			);
		}
		const unplaced = unplacedContent(authored, AUTHORED_SECTIONS);
		if (unplaced !== null) {
			return refuse(
				BAD_SECTIONS,
				unplaced._tag === "Preamble"
					? `${VERB}: stdin carries content above "## Problem" — a spec body holds ${AUTHORED_SECTIONS.join(", ")} and nothing else, and composing would have dropped it.`
					: `${VERB}: stdin carries section "${unplaced.heading}", which is not one of ${AUTHORED_SECTIONS.join(", ")} — composing would have dropped it.`,
			);
		}

		const document = yield* options.trail;
		if (document._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read --trail ${options.trailPath}: ${document.reason} — nothing was composed.`,
			);
		}
		const parsed = parseTrailDocument(document.text);
		if (parsed._tag === "Unreadable") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read --trail ${options.trailPath}: ${parsed.reason} — nothing was composed.`,
			);
		}
		if (parsed._tag === "Unbindable") {
			return refuse(
				DIGEST_UNBINDABLE,
				parsed.reason === "trailDigest"
					? `${VERB}: --trail ${options.trailPath} does not carry a 12-hex trailDigest — the spec could not be bound to a trail.`
					: `${VERB}: --trail ${options.trailPath} carries a decision with no ${parsed.reason} — it cannot be digested.`,
			);
		}
		const trail = parsed.value;

		if (trail.readiness === "blocked") {
			return refuse(
				TRAIL_BLOCKED,
				`${VERB}: --trail ${options.trailPath} reports readiness "blocked" — ${trail.unresolved.length} decision(s) unresolved: ${trail.unresolved.map((row) => row.ref).join(", ")}. Refusing to synthesize a spec over a decision nobody made.`,
			);
		}
		if (trail.decisions.length === 0) {
			return refuse(
				TRAIL_EMPTY,
				`${VERB}: --trail ${options.trailPath} holds zero decisions — there is nothing to synthesize.`,
			);
		}

		const unknown = options.decisions.find(
			(ref) => !trail.decisions.some((row) => row.ref === ref),
		);
		if (unknown !== undefined) {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: --decisions names ${unknown}, which is not a decision on this trail — the refs on it are ${trail.decisions.map((row) => row.ref).join(", ")}.`,
			);
		}
		const selected =
			options.decisions.length === 0
				? trail.decisions
				: trail.decisions.filter((row) => options.decisions.includes(row.ref));
		if (selected.length === 0) {
			return refuse(
				TRAIL_EMPTY,
				`${VERB}: --decisions selected zero decisions — there is nothing to synthesize.`,
			);
		}

		// Scanned after splicing, so the rendered decisions are scanned too and nothing this verb
		// itself writes can escape the predicate (#3086).
		const composed = composeSpec(authored, selected);
		if (isBareAtReference(composed)) {
			return refuse(
				BARE_AT_PATH,
				`${VERB}: the body is a bare @ path reference — not redactable, refusing to compose it.`,
			);
		}
		const scan = scanBody(composed);
		if (scan.leaks.length > 0) {
			return refuse(
				LEAKED_PATH,
				`${VERB}: the body carries ${scan.leaks.length} machine-local path(s) — refusing to compose them into a spec.`,
				renderLeaks(scan.leaks),
			);
		}

		return answer(composed, [
			`${VERB}: ${selected.length} of ${trail.decisions.length} decision(s) rendered from --trail ${options.trailPath}; readiness "${trail.readiness}".`,
		]);
	});
