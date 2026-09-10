/**
 * `ledger retopology` — rewrite one epic's `## Dependencies` block from its live child links.
 *
 * The repair a founder descope owes. Unlinking a child on the board leaves the epic body's topology
 * naming it, and `lane emit` refuses at `16` for as long as that line stands. Nothing repaired it:
 * the verbs that own the block are the planning group, and every one of them requires a staged plan
 * run, so fixing one line meant re-running a whole authoring pass. `ledger supersede` is the wrong
 * shape too — it closes the child `not_planned` and unlinks it, while a descoped child keeps living
 * on its own lane.
 *
 * So this verb is deliberately the smallest thing that ends the wedge: it holds the epic's claim
 * through {@link openGround} like every sibling, and reads **no** run directory — no `run.json`, no
 * manifest, no staged document — because a cleared run is exactly the state a descoped epic is
 * found in. It closes, unlinks and comments on nothing; retiring a child stays `ledger supersede`'s
 * job.
 *
 * It renders through `renderDependencies` and re-parses through the shipped reader before writing
 * (`checkTopology`'s round trip), so a block the emitter would read differently from how it was
 * rendered is refused with nothing written — and being a rewrite of what is already there, running
 * it twice issues one PATCH: the second run composes the body it is standing in and answers
 * `unchanged`.
 */

import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {capAndCount} from "../evidence.ts";
import {getIssue, patchIssueBody} from "../io/issues.ts";
import {listSubIssues} from "../plan/github.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	BAD_SECTIONS,
	EPIC_MOVED,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	REGION_UNRESOLVABLE,
	TOPOLOGY_INVALID,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {BODY_DIGEST_RE, bodyDigest} from "./digest.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";
import {spliceDependencies} from "./region.ts";
import {checkTopology, type Declared, readDeclared} from "./topology-doc.ts";

const VERB = "ledger retopology";

/**
 * `dropped` is an evidence-array with no reason vocabulary, so it collapses cap-and-count per the
 * bounded-evidence-output-shape decision.
 */
const DROPPED_CAP = 5;

/** The one spelling of a capped `dropped` list, so the two channels never state different counts. */
const droppedList = (dropped: ReadonlyArray<string>): string => {
	const {rows, more} = capAndCount(dropped, DROPPED_CAP);
	return `${rows.join(", ")}${more === 0 ? "" : ` (+${more} more)`}`;
};

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) =>
		`${VERB}: #${epic} is not a type:epic — it declares no child topology to rewrite.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was written.`,
};

export interface RetopologyOptions extends OpenOptions {
	readonly bodyDigest: string;
}

/** The refusal for every arm of the read that is not a topology this verb can rewrite. */
const declaredRefusal = (
	epic: number,
	declared: Exclude<Declared, {_tag: "Declared"}>,
	notes: ReadonlyArray<string>,
): VerbOutcome => {
	switch (declared._tag) {
		case "Absent":
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${epic} carries no readable \`## Dependencies\` topology — there is nothing to rewrite, and planning the epic is what writes one.`,
				notes,
			);
		case "Unparseable":
			return refuse(
				BAD_SECTIONS,
				`${VERB}: #${epic}'s topology line ${declared.line} does not parse: "${declared.text}" — nothing was written.`,
				notes,
			);
		case "Duplicate":
			return refuse(
				TOPOLOGY_INVALID,
				`${VERB}: #${epic}'s topology places #${declared.child} in more than one phase — nothing was written.`,
				notes,
			);
		case "Unplaced":
			return refuse(
				TOPOLOGY_INVALID,
				`${VERB}: #${epic}'s topology names #${declared.child} in a requires line but places it in no phase — nothing was written.`,
				notes,
			);
		case "Emptied":
			return refuse(
				TOPOLOGY_INVALID,
				`${VERB}: every ref #${epic}'s topology places (${droppedList(declared.dropped)}) is outside its live child list, so the rewrite would place no child — nothing was written.`,
				notes,
			);
		// A drop read never returns `Foreign`; the arm exists so the switch stays total.
		case "Foreign":
			return refuse(
				TOPOLOGY_INVALID,
				`${VERB}: #${epic}'s topology references ${declared.ref}, which is not one of its children — nothing was written.`,
				notes,
			);
	}
};

export const runRetopology = (
	options: RetopologyOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		if (!BODY_DIGEST_RE.test(options.bodyDigest)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --body-digest must be 12 lowercase hex — got "${options.bodyDigest}".`,
			);
		}

		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {repo, epic, notes} = ground;

		const observed = bodyDigest(epic.body);
		if (observed !== options.bodyDigest) {
			return refuse(
				EPIC_MOVED,
				`${VERB}: the epic body moved since the digest was taken (${options.bodyDigest} → ${observed}) — re-read it before writing.`,
				notes,
			);
		}

		const listed = yield* listSubIssues(repo, epic.number, options.env);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				MESSAGES.unreadable(`#${epic.number}'s children`, listed.reason),
				notes,
			);
		}
		const live = listed.value.map((link) => link.number);
		if (live.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: #${epic.number} has no sub-issue links — a topology naming exactly its live children would name nobody, so nothing was written.`,
				notes,
			);
		}

		const declared = readDeclared(epic.body, new Set(live), true);
		if (declared._tag !== "Declared") return declaredRefusal(epic.number, declared, notes);

		const checked = checkTopology(epic.number, declared.lines, live);
		if (checked._tag === "Invalid") {
			return refuse(
				TOPOLOGY_INVALID,
				`${VERB}: the rewritten topology is invalid — ${checked.reason} Nothing was written.`,
				notes,
			);
		}

		const spliced = spliceDependencies({
			epic: epic.number,
			body: epic.body,
			topology: checked.block,
		});
		if (spliced._tag === "Unresolvable") {
			return refuse(REGION_UNRESOLVABLE, `${VERB}: ${spliced.reason}`, notes);
		}

		const composed = {
			answer: "rewritten",
			epic: epic.number,
			children: declared.lines.length,
			phases: checked.phases,
			dropped: {count: declared.dropped.length, ...capAndCount(declared.dropped, DROPPED_CAP)},
			bodyDigest: options.bodyDigest,
		};

		if (normalizeForReadback(spliced.body) === normalizeForReadback(epic.body)) {
			return answer(
				JSON.stringify({
					...composed,
					answer: "unchanged",
					newDigest: options.bodyDigest,
					verified: true,
				}),
				[
					`${VERB}: #${epic.number}'s topology already names exactly its ${live.length} live child(ren) — no PATCH was issued.`,
					...notes,
				],
			);
		}

		const patched = yield* patchIssueBody(repo, epic.number, spliced.body);
		if (patched._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the PATCH was issued and could not be confirmed — the body is UNKNOWN.`,
				[...notes, `${VERB}: ${patched.reason}.`],
			);
		}

		const reread = yield* getIssue(repo, epic.number);
		if (reread._tag !== "Present") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the PATCH was issued and could not be confirmed — the body is UNKNOWN.`,
				notes,
			);
		}
		if (normalizeForReadback(reread.value.body) !== normalizeForReadback(spliced.body)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the body was written and does not read back as composed — it needs a human eye.`,
				notes,
			);
		}

		return answer(
			JSON.stringify({
				...composed,
				newDigest: bodyDigest(reread.value.body),
				verified: true,
			}),
			[
				`${VERB}: rewrote #${epic.number}'s \`## Dependencies\` block over ${live.length} live child(ren)${declared.dropped.length === 0 ? "" : `, dropping ${declared.dropped.length} ref(s): ${droppedList(declared.dropped)}`}.`,
				...notes,
			],
		);
	});
