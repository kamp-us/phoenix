/**
 * `grill open` — open, or resume, the session issue for a topic.
 *
 * **Zero matching sessions is a fact, not a failed read**: no session existing is the ordinary
 * first-run state, and the verb mints one. A search that could not complete is
 * `PRECONDITION_UNKNOWN` and mints nothing, because a caller that reads a failed search as "none"
 * opens a second session and splits the record (ADR 0092).
 *
 * The label write is part of the create, never a caller's follow-up: the label is what makes the
 * session findable, so a created-but-unlabelled issue is the state this verb exists to prevent —
 * and when the label write is the half that fails, the refusal names the issue it orphaned.
 *
 * **Residual race, stated rather than closed.** Two runs interleaved between the same pair of
 * search-and-create calls still mint two sessions. `SESSION_AMBIGUOUS` catches that on the *next*
 * invocation rather than preventing it; a verb claiming to close it would be lying.
 *
 * **`--ticket` swaps the resume key, and that is the whole of it.** A session opened for a
 * wayfinding frontier ticket records the ticket in its body (`../came-from.ts`) and later runs match
 * on *that*, so the same ticket resumes the same session however either title was edited afterwards
 * — the property a title match cannot hold, and without which a second run mints a duplicate and
 * splits the record the map is waiting on (#5661). The number is provenance only: the ticket issue
 * is read for its title and its existence, never for instruction.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {cameFromSection, readCameFrom} from "../came-from.ts";
import {
	addLabels,
	createUnlabelledIssue,
	getIssue,
	listLabels,
	openIssuesWithLabelDetailed,
	resolveRepo,
} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	BARE_AT_PATH,
	LEAKED_PATH,
	NO_TARGET,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	SESSION_AMBIGUOUS,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {normalizeTopic, SESSION_LABEL} from "./session.ts";

export interface OpenOptions {
	/** `null` only with a `--ticket` to take the title from; the two are never both absent. */
	readonly topic: string | null;
	readonly ticket: number | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const SESSION_BODY =
	"A grilling session. Every round, agent answer and founder ruling is recorded as a comment on this issue.\n";

/** The three refusals a title must survive, whether the caller typed it or a ticket supplied it. */
const titleRefusal = (topic: string, source: string): VerbOutcome | null => {
	if (topic === "")
		return refuse(FAILED, `grill open: ${source} is empty — a session needs a subject.`);
	if (isBareAtReference(topic)) {
		return refuse(
			BARE_AT_PATH,
			`grill open: ${source} is a bare @ path reference — not redactable, refusing to open a session titled with it.`,
		);
	}
	const scan = scanBody(topic);
	const firstLeak = scan.leaks[0];
	return firstLeak === undefined
		? null
		: refuse(
				LEAKED_PATH,
				`grill open: ${source} carries a machine-local path: ${firstLeak.text} — refusing to open a session titled with it.`,
				renderLeaks(scan.leaks),
			);
};

export const runOpen = (
	options: OpenOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const given = options.topic === null ? null : options.topic.trim();
		if (given === null && options.ticket === null) {
			return refuse(
				FAILED,
				"grill open: neither --topic nor --ticket was given — a session needs a subject, or a ticket to take one from.",
			);
		}
		if (given !== null) {
			const bad = titleRefusal(given, "--topic");
			if (bad !== null) return bad;
		}

		const repoAttempt = yield* resolveRepo(options.repo, options.env);
		if (repoAttempt._tag === "Failure") {
			return refuse(
				FAILED,
				"grill open: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.",
			);
		}
		const repo = repoAttempt.value;

		const labels = yield* listLabels(repo);
		if (labels._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill open: cannot read the labels of ${repo}: ${labels.reason} — whether "${SESSION_LABEL}" exists is UNKNOWN. Nothing was created.`,
			);
		}
		if (!labels.value.includes(SESSION_LABEL)) {
			return refuse(
				NO_TARGET,
				`grill open: label "${SESSION_LABEL}" does not exist in ${repo} — refusing to open a session no later run can find. Run the front-door bootstrap: fabrika status bootstrap issue-shape-markers.`,
			);
		}

		let derived: string | null = null;
		if (options.ticket !== null) {
			const ticket = yield* getIssue(repo, options.ticket);
			if (ticket._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`grill open: cannot read #${options.ticket} in ${repo}: ${ticket.reason} — whether the ticket exists is UNKNOWN. Nothing was created.`,
				);
			}
			if (ticket._tag === "Absent") {
				return refuse(
					NO_TARGET,
					`grill open: #${options.ticket} does not exist in ${repo} — refusing to bind a session to an issue no later run will read.`,
				);
			}
			derived = ticket.value.title.trim();
		}
		const topic = given ?? (derived as string);
		if (given === null) {
			const bad = titleRefusal(topic, `#${options.ticket}'s title`);
			if (bad !== null) return bad;
		}

		const open = yield* openIssuesWithLabelDetailed(repo, SESSION_LABEL);
		if (open._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`grill open: cannot search ${repo} for open sessions: ${open.reason} — whether a session already exists is UNKNOWN, never "none". Re-run; do not mint a second one.`,
			);
		}

		// The key is the ticket whenever there is one: a title match cannot survive either title
		// being edited, and a second session on one ticket is the split the map cannot see (#5661).
		const wanted = normalizeTopic(topic);
		const key = options.ticket === null ? `topic "${topic}"` : `ticket #${options.ticket}`;
		const matches =
			options.ticket === null
				? open.value.filter((row) => normalizeTopic(row.title) === wanted)
				: open.value.filter((row) => readCameFrom(row.body) === options.ticket);
		const scopeLine = `grill open: ${repo}, ${open.value.length} open ${SESSION_LABEL} issue(s) scanned, ${matches.length} matching ${key}.`;

		if (matches.length > 1) {
			return refuse(
				SESSION_AMBIGUOUS,
				`grill open: ${matches.length} open sessions match ${key}: ${matches
					.map((row) => `#${row.number}`)
					.join(", ")} — refusing to guess which one is live.`,
				[scopeLine],
			);
		}

		const resumed = matches[0];
		if (resumed !== undefined) {
			const record = yield* getIssue(repo, resumed.number);
			if (record._tag === "Absent") {
				return refuse(
					NO_TARGET,
					`grill open: session #${resumed.number} does not exist, or is not a grilling session.`,
					[scopeLine],
				);
			}
			if (record._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`grill open: cannot read #${resumed.number} in ${repo}: ${record.reason} — which session to resume is UNKNOWN. Nothing was created.`,
					[scopeLine],
				);
			}
			return answer(
				JSON.stringify({
					session: resumed.number,
					topic,
					ticket: options.ticket,
					created: false,
					url: record.value.url,
				}),
				[scopeLine],
			);
		}

		const body =
			options.ticket === null
				? SESSION_BODY
				: `${SESSION_BODY}\n${cameFromSection(options.ticket)}`;
		const created = yield* createUnlabelledIssue(repo, topic, body);
		if (created._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`grill open: the create failed, so whether a session issue exists is UNKNOWN — check ${repo} before re-running.`,
				[scopeLine],
			);
		}

		const landed = yield* getIssue(repo, created.value.number);
		const mismatch =
			landed._tag === "Present"
				? normalizeForReadback(landed.value.title) === normalizeForReadback(topic)
					? null
					: "the landed title differs from the topic that was sent"
				: landed._tag === "Absent"
					? "the created issue reads back absent"
					: `the read-back itself failed: ${landed.reason}`;
		if (mismatch !== null) {
			return refuse(
				READBACK_MISMATCH,
				`grill open: created #${created.value.number} but the read-back does not match what was sent: ${mismatch}.`,
				[scopeLine],
			);
		}

		const labelled = yield* addLabels(repo, created.value.number, [SESSION_LABEL]);
		if (labelled._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`grill open: the label write on #${created.value.number} failed, so the session may exist unlabelled and unfindable — check #${created.value.number} before re-running.`,
				[scopeLine],
			);
		}

		return answer(
			JSON.stringify({
				session: created.value.number,
				topic,
				ticket: options.ticket,
				created: true,
				url: created.value.url,
			}),
			[scopeLine],
		);
	});
