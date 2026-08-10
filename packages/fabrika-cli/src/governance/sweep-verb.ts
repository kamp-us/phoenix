/**
 * `governance sweep` — the uncited live-`accepted` records whose decision domain a subject touches,
 * ranked, for a subject read out of a bound commit (`--record`) or out of the corpus (`--landed`).
 *
 * **The ranking core is imported, never restated.** `decisionBearingText`, `tokenize`, the idf scoring,
 * `RARITY_FLOOR` and `DEFAULT_LIMIT` all come from `../adr/sweep.ts`. A second lexical sweep would be a
 * rival answer to a solved question, and two runs of the two verbs over the same bytes would stop
 * agreeing by construction. What this verb owns is the **subject acquisition**: `adr sweep` can only
 * read a local draft, and a review-time or digest-time subject lives in a commit.
 *
 * All three outcomes exit 0 and all three are answers — and none of them is a clearance. A record that
 * disagrees with the subject about what a *label means* shares no distinctive vocabulary and never
 * appears here at all, which is why `no-overlap` carries that sentence in `reason` verbatim.
 */
import {Effect, type FileSystem, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {idFromFile, isFourDigitId, partitionRecordNames} from "../adr/records.ts";
import {renderEntry, type SweepCandidate, sweep} from "../adr/sweep.ts";
import {readDir, readFile} from "../io/fs.ts";
import {diffRangeStatuses, readFileAt} from "../io/git.ts";
import {badNumber, openPull, resolveTargetRepo} from "../review/target.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {INCOMPLETE_SCAN, OFF_VOCABULARY, PRECONDITION_UNKNOWN, ZERO_SCOPE} from "./codes.ts";
import {bindGovernanceHead, boundLine} from "./head.ts";

const VERB = "governance sweep";

const UNKNOWN_TAIL = "the subject cannot be bound to a commit, so what it says is UNKNOWN.";

export interface SweepOptions {
	/** The PR the subject record lives in. `null` with `--landed` is the corpus mode. */
	readonly pr: number | null;
	readonly record: string | null;
	readonly landed: string | null;
	readonly sha: string | null;
	readonly dir: string;
	readonly limit: number;
	readonly repo: string | null;
	readonly json: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Every record in the corpus, or the refusal its unreadability seats. */
type Corpus =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Corpus"; readonly records: ReadonlyArray<SweepCandidate>};

const readCorpus = (dir: string): Effect.Effect<Corpus, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const root = dir.replace(/\/+$/, "");
		const listing = yield* Effect.result(readDir(root));
		if (Result.isFailure(listing)) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${root}: the directory could not be listed — an incomplete corpus is UNKNOWN, never "no-overlap".`,
				),
			};
		}
		const {records} = partitionRecordNames(listing.success);
		if (records.length === 0) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					ZERO_SCOPE,
					`${VERB}: scanned ${root}, 0 decision records — refusing to answer (ADR 0092).`,
				),
			};
		}
		const corpus: SweepCandidate[] = [];
		for (const file of records) {
			const text = yield* Effect.result(readFile(`${root}/${file}`));
			// One unreadable member makes the corpus INCOMPLETE, and an incomplete corpus is UNKNOWN —
			// ranking against the rest would answer `no-overlap` over a corpus nobody scanned.
			if (Result.isFailure(text)) {
				return {
					_tag: "Refused" as const,
					outcome: refuse(
						PRECONDITION_UNKNOWN,
						`${VERB}: cannot read ${root}/${file}: the file could not be read — an incomplete corpus is UNKNOWN, never "no-overlap".`,
					),
				};
			}
			corpus.push({id: idFromFile(file) ?? file, file, text: text.success});
		}
		return {_tag: "Corpus" as const, records: corpus};
	});

export const runSweep = (
	options: SweepOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const {pr, landed, json} = options;
		if ((pr === null) === (landed === null)) {
			return refuse(OFF_VOCABULARY, `${VERB}: pass a PR with --record, or --landed, never both.`);
		}
		if (options.limit < 0) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --limit ${options.limit} is negative — a shortlist cannot be shorter than empty.`,
			);
		}
		const subjectId = landed ?? options.record;
		if (subjectId === null || !isFourDigitId(subjectId)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --${landed === null ? "record" : "landed"} "${subjectId ?? ""}" is not a four-digit decision id.`,
			);
		}

		const root = options.dir.replace(/\/+$/, "");
		const corpus = yield* readCorpus(options.dir);
		if (corpus._tag === "Refused") return corpus.outcome;

		const diagnostics: string[] = [];
		let subjectText: string;
		if (pr === null) {
			const member = corpus.records.find((entry) => entry.id === subjectId);
			if (member === undefined) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: ${root} carries no decision record ${subjectId} — nothing to sweep.`,
				);
			}
			subjectText = member.text;
		} else {
			const bad = badNumber(VERB, "a pull-request number", pr);
			if (bad !== null) return bad;
			const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
			if (resolved._tag === "Refused") return resolved.outcome;
			const repo = resolved.repo;

			const target = yield* openPull(VERB, repo, pr, {
				requireOpen: true,
				closedReason: "nothing to sweep.",
				requireFiles: true,
				emptyReason: "refusing to sweep over an empty diff (ADR 0092).",
				unknownMessage: (reason) =>
					`${VERB}: cannot read PR #${pr} in ${repo}: ${reason} — what the subject says is UNKNOWN.`,
			});
			if (target._tag === "Refused") return target.outcome;

			const bound = yield* bindGovernanceHead(
				VERB,
				UNKNOWN_TAIL,
				repo,
				pr,
				target.pull,
				options.sha,
			);
			if (bound._tag === "Refused") return bound.outcome;
			const head = bound.head;
			diagnostics.push(boundLine(VERB, head));

			const listed = yield* diffRangeStatuses(head.base, head.sha);
			if (listed._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read the changed files of #${pr} at ${head.sha}: ${listed.reason} — ${UNKNOWN_TAIL}`,
				);
			}
			if (listed.value.length < target.pull.changedFiles) {
				return refuse(
					INCOMPLETE_SCAN,
					`${VERB}: ${head.sha} carries ${listed.value.length} of the ${target.pull.changedFiles} files #${pr} declares — refusing to prove ${subjectId} is in this PR from a short read (#3999).`,
					diagnostics,
				);
			}
			const carried = listed.value.find(
				(entry) => idFromFile(entry.path.split("/").pop() ?? "") === subjectId,
			);
			if (carried === undefined) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: #${pr} at ${head.sha} carries no decision record ${subjectId} — nothing to sweep.`,
					diagnostics,
				);
			}
			const bytes = yield* readFileAt(head.sha, carried.path);
			if (bytes._tag === "Failure") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${carried.path} at ${head.sha}: ${bytes.reason} — ${UNKNOWN_TAIL}`,
					diagnostics,
				);
			}
			subjectText = bytes.value;
		}

		const result = sweep({id: subjectId, text: subjectText}, corpus.records, options.limit);
		diagnostics.push(
			`${VERB}: ranked ${result.inScope} uncited live-accepted records of ${result.scanned} in scope.`,
		);
		if (result.reason !== null) diagnostics.push(`${VERB}: ${result.reason}.`);

		if (json) {
			return answer(
				JSON.stringify({
					outcome: result.outcome,
					subject: subjectId,
					entries: result.entries,
					reason: result.reason,
					scanned: result.scanned,
					inScope: result.inScope,
					cited: result.cited,
				}),
				diagnostics,
			);
		}
		return answer([result.outcome, ...result.entries.map(renderEntry)].join("\n"), diagnostics);
	});
