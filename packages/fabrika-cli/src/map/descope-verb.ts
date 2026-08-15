/**
 * `map descope` — append a rejected direction and its reasoning to the never-graduating out-of-scope
 * section, optionally retiring the frontier ticket that asked it.
 *
 * <!-- anchor: OUT-OF-SCOPE-NEVER-GRADUATES --> **This section is append-only and has no removal
 * path, by construction: no verb in this group deletes from it.** Every other section empties as fog
 * clears; this one is the map's memory of what was decided *against*, and an entry that can be
 * removed is one the next session re-proposes. Reversing a rejection is a new decision under
 * `## Decisions` naming the entry it overturns — both stay on the record.
 *
 * **The fence is checked, not assumed.** The composed section is validated with `appendOnly` and a
 * re-parse that must hold every prior entry plus exactly one more; a write that would drop or mutate
 * an existing entry refuses, because the read-back proves the body no longer holds what it held.
 *
 * <!-- anchor: EVERY-TICKET-HAS-AN-EXIT --> `--ticket` is the second exit off the frontier, and it is
 * what keeps `clear` reachable: a question whose lane returned `unreachable` has no answer to record,
 * so without a retiring path it would hold the frontier forever and `graduate` could never run.
 */

import {Effect, type FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readFile} from "../io/fs.ts";
import {closeCompleted, createComment, getIssue, patchIssueBody} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {appendOnly} from "../review/append.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	digestOf,
	foldEntryText,
	type OutOfScopeEntry,
	parseBody,
	renderFrontierRow,
	renderOutOfScope,
	spliceSection,
} from "./body.ts";
import {ALREADY_DESCOPED, BAD_SECTIONS, READBACK_MISMATCH, WRITE_UNKNOWN} from "./codes.ts";
import {
	digestFresh,
	leakFree,
	notTerminal,
	requireMap,
	requireTicket,
	targetRepo,
} from "./guards.ts";
import {composeRetiredMarker} from "./markers.ts";
import {namesSameThing} from "./open.ts";

export interface DescopeOptions {
	readonly map: number;
	readonly digest: string;
	readonly direction: string;
	readonly reason: string;
	/**
	 * The frontier ticket this direction retires, when the rejection is also a ticket's exit.
	 *
	 * Optional, and named in the contract's exit table (`13`/`18`) and in `map record`'s refusal text
	 * rather than in its Inputs table — see the spec-defect note on #5022.
	 */
	readonly ticket: number | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Today, injected so an appended entry is byte-reproducible in a test. */
	readonly now: () => Date;
}

const VERB = "map descope";

export const runDescope = (
	options: DescopeOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const direction = options.direction.trim();
		if (direction === "") {
			return refuse(
				FAILED,
				`${VERB}: --direction is empty — refusing to reject an unnamed direction.`,
			);
		}

		const read = yield* readFile(options.reason).pipe(
			Effect.map((value) => ({ok: true as const, value})),
			Effect.catchTag("fabrika-cli/ReadFailed", (cause) =>
				Effect.succeed({ok: false as const, value: cause.reason}),
			),
		);
		if (!read.ok) {
			return refuse(
				FAILED,
				`${VERB}: could not read --reason ${options.reason}: ${read.value} — the reasoning is UNKNOWN, never empty.`,
			);
		}
		const reason = foldEntryText(read.value);
		if (reason === "") {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: --reason ${options.reason} is empty — an out-of-scope entry with no reasoning is one the next session re-proposes.`,
			);
		}
		const leaked = leakFree(VERB, "direction", direction) ?? leakFree(VERB, "reason", reason);
		if (leaked !== null) return leaked;

		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const found = yield* requireMap(VERB, repo, options.map);
		if (found._tag === "Refused") return found.outcome;
		const stale = digestFresh(VERB, options.map, found.value.body, options.digest);
		if (stale !== null) return stale;

		const already = found.value.body.outOfScope.find((entry) =>
			namesSameThing(direction, entry.direction),
		);
		if (already !== undefined) {
			return refuse(
				ALREADY_DESCOPED,
				`${VERB}: "${direction}" is already out of scope on #${options.map} (${already.recordedAt}) — nothing was written; the recorded reasoning stands.`,
			);
		}

		let retiring: number | null = null;
		if (options.ticket !== null) {
			const resolved = yield* requireTicket(
				VERB,
				repo,
				options.map,
				found.value.body,
				options.ticket,
			);
			if (resolved._tag === "Refused") return resolved.outcome;
			const left = notTerminal(VERB, resolved.value.ticket, "there is nothing left to retire.");
			if (left !== null) return left;
			retiring = options.ticket;
		}

		const entry: OutOfScopeEntry = {
			direction,
			reason: reason.replace(/\.$/, ""),
			recordedAt: options.now().toISOString().slice(0, 10),
		};
		const priorEntries = found.value.body.outOfScope.map(renderOutOfScope);
		const composed = [...priorEntries, renderOutOfScope(entry)].join("\n");
		// The fence compares RENDERED entries, not the raw section bytes, and the empty case is its own
		// arm: `appendOnly` counts lines, and an empty section splits to one empty line, so a first
		// entry would read as "the composed section has 1 line, expected 2" and refuse the ordinary
		// opening write.
		const violation =
			priorEntries.length === 0
				? composed === renderOutOfScope(entry)
					? null
					: "the composed section is not exactly this one entry"
				: (() => {
						const fence = appendOnly(priorEntries.join("\n"), composed);
						return fence._tag === "Violates" ? fence.reason : null;
					})();
		if (violation !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the composed out-of-scope section is not the old one plus this entry (${violation}) — nothing was written.`,
			);
		}

		let next = spliceSection(found.value.body, "Out of scope", composed);
		if (retiring !== null) {
			const withEntry = parseBody(next);
			if (withEntry._tag === "Malformed") {
				return refuse(
					BAD_SECTIONS,
					`${VERB}: #${options.map}'s body stops parsing once the entry is appended (${withEntry.reason}) — nothing was written.`,
				);
			}
			next = spliceSection(
				withEntry.value,
				"Frontier",
				withEntry.value.frontier
					.filter((row) => row.ticket !== retiring)
					.map(renderFrontierRow)
					.join("\n"),
			);
		}

		const scope = `${VERB}: ${repo}, ${found.value.body.outOfScope.length} existing out-of-scope entry(ies)${retiring === null ? "" : `, retiring #${retiring}`}.`;
		const written = yield* patchIssueBody(repo, options.map, next);
		if (written._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: could not write #${options.map}'s body: ${written.reason} — whether the rejection landed is UNKNOWN.`,
				[scope],
			);
		}
		const landed = yield* getIssue(repo, options.map);
		if (
			landed._tag !== "Present" ||
			normalizeForReadback(landed.value.body) !== normalizeForReadback(next)
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote #${options.map}'s body and the read-back differs — the map needs fixing by hand.`,
				[scope],
			);
		}
		const reparsed = parseBody(landed.value.body);
		if (
			reparsed._tag === "Malformed" ||
			reparsed.value.outOfScope.length !== found.value.body.outOfScope.length + 1
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote #${options.map}'s body and the out-of-scope section did not grow by exactly one entry — the map needs fixing by hand.`,
				[scope],
			);
		}

		if (retiring !== null) {
			const marker = yield* createComment(
				repo,
				retiring,
				composeRetiredMarker({map: options.map, ticket: retiring, direction}),
			);
			if (marker._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: recorded the rejection on #${options.map} and the retire marker on #${retiring} did NOT land — the entry is on the map and the ticket is not retired.`,
					[scope],
				);
			}
			const closed = yield* closeCompleted(repo, retiring);
			if (closed._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: recorded the rejection on #${options.map} and the close of #${retiring} did NOT land — close #${retiring} by hand.`,
					[scope],
				);
			}
		}

		return answer(
			JSON.stringify({
				map: options.map,
				direction,
				entries: reparsed.value.outOfScope.length,
				digest: digestOf(reparsed.value.sections),
			}),
			[scope],
		);
	});
