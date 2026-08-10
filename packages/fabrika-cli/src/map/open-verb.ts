/**
 * `map open` — mint or resume the map for a destination, refusing a destination that is not fog.
 *
 * The check order is local-first: everything decidable from the bytes on stdin runs before any
 * network read, so a refusable input costs no API call and a refusal always names the cheapest
 * correctable thing first.
 *
 * **Zero open maps is a fact, not a failed read** — the first map in a repository is the ordinary
 * case. A search that could not complete is `11`, and nothing is written.
 *
 * **Write order, and what a partial application leaves.** The issue is created first, the label
 * second. A failure between them leaves a map issue nobody can find, which is `8` with the number
 * named on stderr so a human can finish it — the surviving half is inert rather than harmful. The
 * reverse order is not available (a label cannot be applied to an issue that does not exist), which
 * is why the orphan is named rather than prevented.
 */

import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {
	addLabels,
	createUnlabelledIssue,
	getIssue,
	listLabels,
	openIssuesWithLabel,
	searchIssues,
} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {tokenize} from "../report/dedup.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {digestOfBody, type MapBody, parseBody, renderMintBody} from "./body.ts";
import {
	ALREADY_DESCOPED,
	EMPTY_STDIN,
	MAP_AMBIGUOUS,
	NO_TARGET,
	NOT_FOG,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {MAP_LABEL} from "./frontier.ts";
import {leakFree, targetRepo} from "./guards.ts";
import {
	candidatesFor,
	isQuestion,
	linesOf,
	mapTitle,
	namesSameThing,
	type QuestionCandidate,
} from "./open.ts";

export interface OpenOptions {
	readonly destination: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The fd-0 read, injected so the failed-read and TTY paths are testable without a descriptor. */
	readonly stdin: Effect.Effect<StdinRead>;
}

interface OpenMap {
	readonly number: number;
	readonly body: MapBody;
}

const VERB = "map open";

export const runOpen = (
	options: OpenOptions,
): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const destination = options.destination.trim();
		if (destination === "") {
			return refuse(FAILED, `${VERB}: --destination is empty — refusing to chart an unnamed fog.`);
		}

		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const read = yield* options.stdin;
		if (read._tag === "Failed") {
			return refuse(
				FAILED,
				`${VERB}: could not read stdin: ${read.reason} — the questions are UNKNOWN, never absent.`,
			);
		}
		const lines = linesOf(read._tag === "NoStdin" ? "" : read.text);
		if (lines.length === 0) {
			return refuse(
				EMPTY_STDIN,
				`${VERB}: stdin was read and held no question — a destination with no open question is not fog.`,
			);
		}

		const leaked = leakFree(VERB, "destination", destination) ?? leakFree(VERB, "question", lines.join("\n"));
		if (leaked !== null) return leaked;

		const questions = lines.filter(isQuestion);
		if (questions.length === 0) {
			return refuse(
				NOT_FOG,
				`${VERB}: none of the ${lines.length} supplied line(s) is stated as a question — a destination with no stated question is not fog. This belongs in intake, not on a map.`,
			);
		}

		const labels = yield* listLabels(repo);
		if (labels._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the label set of ${repo}: ${labels.reason} — nothing was written and whether this destination is charted is UNKNOWN.`,
			);
		}
		if (!labels.value.includes(MAP_LABEL)) {
			return refuse(
				NO_TARGET,
				`${VERB}: the ${MAP_LABEL} label does not exist in ${repo} — refusing to open an unlabelled map no later run could find.`,
			);
		}

		const listed = yield* openIssuesWithLabel(repo, MAP_LABEL);
		if (listed._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot search ${repo} for existing maps: ${listed.reason} — nothing was written and whether this destination is charted is UNKNOWN.`,
			);
		}

		const maps: OpenMap[] = [];
		for (const row of listed.value) {
			const issue = yield* getIssue(repo, row.number);
			if (issue._tag === "Unknown") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read map #${row.number}: ${issue.reason} — nothing was written and whether this destination is charted is UNKNOWN.`,
				);
			}
			// A map that vanished between the list and the read is not a map this run must reconcile:
			// the list is a snapshot, and an issue closed in that window is no longer open.
			if (issue._tag === "Absent") continue;
			const parsed = parseBody(issue.value.body);
			if (parsed._tag === "Malformed") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: map #${row.number}'s body does not parse (${parsed.reason}) — nothing was written and whether this destination is charted is UNKNOWN.`,
				);
			}
			maps.push({number: row.number, body: parsed.value});
		}

		for (const map of maps) {
			const rejected = map.body.outOfScope.find((entry) =>
				namesSameThing(destination, entry.direction),
			);
			if (rejected !== undefined) {
				return refuse(
					ALREADY_DESCOPED,
					`${VERB}: this destination is recorded out of scope on map #${map.number} (${rejected.recordedAt}) — read the recorded reasoning before re-proposing it.`,
				);
			}
		}

		const charted = maps.filter((map) => namesSameThing(destination, map.body.destination));
		if (charted.length > 1) {
			return refuse(
				MAP_AMBIGUOUS,
				`${VERB}: ${charted.length} open maps match this destination (${charted.map((map) => `#${map.number}`).join(", ")}) — refusing to guess which; close or merge one.`,
			);
		}

		const answeredCandidates: {
			question: string;
			candidates: ReadonlyArray<QuestionCandidate>;
		}[] = [];
		let candidateRows = 0;
		for (const question of questions) {
			const hits = yield* searchIssues(repo, tokenize(question));
			if (hits._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the board for "${question}": ${hits.reason} — nothing was written and whether it is already answered is UNKNOWN.`,
				);
			}
			const candidates = candidatesFor(question, hits.value);
			candidateRows += candidates.length;
			if (candidates.length > 0) answeredCandidates.push({question, candidates});
		}

		const scope = `${VERB}: ${repo}, ${maps.length} open map(s) searched, ${lines.length} line(s) read, ${questions.length} stated as question(s), ${candidateRows} candidate(s) ranked.`;
		const scanned = {maps: maps.length, candidates: candidateRows};

		const resumed = charted[0];
		if (resumed !== undefined) {
			// The body is not touched at all on a resume: appending the supplied questions would
			// duplicate fog a previous session already recorded, and this verb takes no `--digest`, so it
			// holds no guard that would make a body write safe.
			return answer(
				JSON.stringify({
					map: resumed.number,
					created: false,
					destination,
					questions: questions.length,
					answeredCandidates,
					digest: digestOfBody(resumed.body),
					scanned,
				}),
				[scope],
			);
		}

		const body = renderMintBody(destination, questions);
		const created = yield* createUnlabelledIssue(repo, mapTitle(destination), body);
		if (created._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: could not create the map in ${repo}: ${created.reason} — whether it landed is UNKNOWN. Re-run and read the refusal before filing again.`,
				[scope],
			);
		}
		const labelled = yield* addLabels(repo, created.value.number, [MAP_LABEL]);
		if (labelled._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: created #${created.value.number} and the label write did NOT land — the map exists and no later run can find it. Add ${MAP_LABEL} to #${created.value.number} by hand.`,
				[scope],
			);
		}

		// A create call's own response is the server echoing the request; a fresh read is the only
		// evidence the map is on the board carrying its label.
		const landed = yield* getIssue(repo, created.value.number);
		let landedBody: MapBody | null = null;
		let mismatch: string | null = null;
		if (landed._tag === "Absent") mismatch = "the map is not readable after the create";
		else if (landed._tag === "Unknown") mismatch = `the read-back itself failed: ${landed.reason}`;
		else if (!landed.value.labels.includes(MAP_LABEL)) mismatch = `it does not carry ${MAP_LABEL}`;
		else if (normalizeForReadback(landed.value.body) !== normalizeForReadback(body)) {
			mismatch = "the landed body differs from what was composed";
		} else {
			const reparsed = parseBody(landed.value.body);
			if (reparsed._tag === "Malformed") mismatch = `the landed body does not parse: ${reparsed.reason}`;
			else landedBody = reparsed.value;
		}
		if (mismatch !== null || landedBody === null) {
			return refuse(
				READBACK_MISMATCH,
					`${VERB}: created #${created.value.number} but the read-back is wrong: ${mismatch ?? "the landed body could not be re-parsed"}. The map exists and needs fixing by hand.`,
				[scope],
			);
		}

		return answer(
			JSON.stringify({
				map: created.value.number,
				created: true,
				destination,
				questions: questions.length,
				answeredCandidates,
				digest: digestOfBody(landedBody),
				scanned,
			}),
			[scope],
		);
	});
