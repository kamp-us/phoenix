/**
 * `spike dispose` — prove the repository tree is unchanged and the capture still covers the log,
 * remove the workspace, and prove it is gone.
 *
 * This is the group's one **judging** verb: it judges whether the throwaway stayed thrown away, and
 * its verdict rests on the digest comparison stated on stderr as the scope line. An absent manifest
 * is `12` before any judgment is attempted, never a clean verdict over nothing.
 *
 * **The tree comparison runs first — before any state read and before any write.** That ordering is
 * what keeps a `17`, the refusal this verb most exists for, from destroying the leak it just found
 * (the #4111 shape). It does **not** make every non-zero exit write-free: `8`, `9` and `16` all sit
 * past the `--forfeit` write or past the removal.
 *
 * **`--forfeit` relaxes neither `17` nor `21`.** Forfeiting is about the absence of a decision; those
 * two are about whether the throwaway stayed thrown away and whether the record is current, and they
 * are independent questions.
 *
 * **A manifest carrying `spike: null` skips the issue half entirely** — no `15`, no `21`, no forfeit,
 * no GitHub read — leaving only the tree comparison and the removal, so the orphaned workspace a `20`
 * leaves behind is always collectable.
 */

import {Effect} from "effect";
import {exists, removeAll} from "../io/fs.ts";
import {closeCompleted, createComment, getComment, getIssue, listComments} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {forfeitNote, newestCapture} from "./bodies.ts";
import {
	CAPTURE_STALE,
	NOT_CAPTURED,
	READ_OR_EXEC_UNKNOWN,
	READBACK_MISMATCH,
	REMOVAL_UNPROVEN,
	TREE_MOVED,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	leakFree,
	nonceGrammar,
	readEvidence,
	readManifest,
	readTree,
	type SpikeEffect,
	targetRepo,
} from "./guards.ts";
import {type EvidenceRecord, workspacePath} from "./workspace.ts";

export interface DisposeOptions {
	readonly nonce: string;
	readonly forfeit: boolean;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly tmpRoot: string;
}

const VERB = "spike dispose";

export const runDispose = (options: DisposeOptions): SpikeEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const grammar = nonceGrammar(VERB, options.nonce, "");
		if (grammar !== null) return grammar;

		const workspace = workspacePath(options.tmpRoot, options.nonce);
		const manifest = yield* readManifest(
			VERB,
			workspace,
			options.nonce,
			"it was already disposed, or never opened.",
		);
		if (manifest._tag === "Refused") return manifest.outcome;

		const tree = yield* readTree(VERB, manifest.value.treeRoot);
		if (tree._tag === "Refused") return tree.outcome;
		const scope = `${VERB}: nonce ${options.nonce}, tree ${manifest.value.treeRoot}, ${tree.value.lines.length} status line(s).`;
		if (tree.value.digest !== manifest.value.treeDigest) {
			return refuse(
				TREE_MOVED,
				`${VERB}: the working tree changed since the spike opened (${tree.value.lines.length} paths, first: ${first(tree.value.lines)}) — the workspace is intact and NOT removed.`,
				[scope, ...tree.value.lines.map((line) => `${VERB}:   ${line}`)],
			);
		}

		const evidence = yield* readEvidence(VERB, workspace);
		if (evidence._tag === "Refused") return evidence.outcome;
		const records = evidence.value.records;

		let forfeited = false;
		if (manifest.value.spike !== null) {
			const issueHalf = yield* resolveIssueHalf({
				spike: manifest.value.spike,
				nonce: options.nonce,
				forfeit: options.forfeit,
				question: manifest.value.question,
				records,
				evidenceDigest: evidence.value.digest,
				repo: options.repo,
				env: options.env,
				scope,
			});
			if (issueHalf._tag === "Refused") return issueHalf.outcome;
			forfeited = issueHalf.forfeited;
		}

		const removed = yield* removeAll(workspace).pipe(
			Effect.map((): string | null => null),
			Effect.catchTag("fabrika-cli/WriteFailed", (failure) => Effect.succeed(failure.reason)),
		);
		if (removed !== null) {
			return refuse(
				REMOVAL_UNPROVEN,
				`${VERB}: the workspace ${workspace} could not be removed: ${removed} — disposal is UNPROVEN, and this spike is not disposed.`,
				[scope],
			);
		}
		// A removal nobody checked is the self-report class again, one directory down.
		const stillThere = yield* exists(workspace).pipe(Effect.orElseSucceed(() => true));
		if (stillThere) {
			return refuse(
				REMOVAL_UNPROVEN,
				`${VERB}: the workspace ${workspace} is still present after removal — disposal is UNPROVEN, and this spike is not disposed.`,
				[scope],
			);
		}

		return answer(
			JSON.stringify({
				spike: manifest.value.spike,
				nonce: options.nonce,
				workspace: "removed",
				treeMatched: true,
				runs: records.length,
				forfeited,
			}),
			[scope],
		);
	});

const first = (lines: ReadonlyArray<string>): string => lines[0] ?? "<none>";

type IssueHalf =
	| {readonly _tag: "Ok"; readonly forfeited: boolean}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

const resolveIssueHalf = (input: {
	readonly spike: number;
	readonly nonce: string;
	readonly forfeit: boolean;
	readonly question: string;
	readonly records: ReadonlyArray<EvidenceRecord>;
	readonly evidenceDigest: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly scope: string;
}): SpikeEffect<IssueHalf> =>
	Effect.gen(function* () {
		const refused = (outcome: VerbOutcome): IssueHalf => ({_tag: "Refused", outcome});
		const target = yield* targetRepo(VERB, input.repo, input.env);
		if (target._tag === "Refused") return refused(target.outcome);
		const repo = target.value;

		const issue = yield* getIssue(repo, input.spike);
		if (issue._tag === "Absent") {
			return refused(
				refuse(
					ZERO_SCOPE,
					`${VERB}: spike #${input.spike} is proven absent — there is nothing to forfeit to.`,
					[input.scope],
				),
			);
		}
		if (issue._tag === "Unknown") {
			return refused(
				refuse(
					READ_OR_EXEC_UNKNOWN,
					`${VERB}: cannot read spike #${input.spike}: ${issue.reason} — nothing was removed.`,
					[input.scope],
				),
			);
		}
		const comments = yield* listComments(repo, input.spike);
		if (comments._tag === "Failure") {
			return refused(
				refuse(
					READ_OR_EXEC_UNKNOWN,
					`${VERB}: cannot read the comments of spike #${input.spike}: ${comments.reason} — nothing was removed.`,
					[input.scope],
				),
			);
		}

		const marker = newestCapture(comments.value, input.nonce);
		if (marker !== null && marker.evidenceDigest !== input.evidenceDigest) {
			return refused(
				refuse(
					CAPTURE_STALE,
					`${VERB}: the evidence log moved after the decision was captured (${input.records.length} runs now; the capture was written over evidenceDigest ${marker.evidenceDigest}) — re-run spike capture to supersede the stale decision, then dispose. If capture refuses on 19, someone holding write must run it. Nothing was removed.`,
					[input.scope],
				),
			);
		}
		if (!input.forfeit && (marker === null || issue.value.state !== "closed")) {
			return refused(
				refuse(
					NOT_CAPTURED,
					`${VERB}: spike #${input.spike} carries no captured decision — disposing now destroys what a decision would rest on. Capture it, or pass --forfeit to abandon it on the record.`,
					[input.scope],
				),
			);
		}
		if (!input.forfeit) return {_tag: "Ok", forfeited: false};

		const body = forfeitNote({
			nonce: input.nonce,
			question: input.question,
			records: input.records,
		});
		const leaked = leakFree(VERB, "composed forfeit note", body);
		if (leaked !== null) return refused({...leaked, stderr: [input.scope, ...leaked.stderr]});

		const posted = yield* createComment(repo, input.spike, body);
		if (posted._tag === "Failure") {
			return refused(
				refuse(
					WRITE_UNKNOWN,
					`${VERB}: the forfeit note failed to post: ${posted.reason} — it may or may not have landed; read spike #${input.spike} before re-running. Nothing was removed.`,
					[input.scope],
				),
			);
		}
		const back = yield* getComment(repo, posted.value.id);
		if (
			back._tag === "Failure" ||
			normalizeForReadback(back.value) !== normalizeForReadback(body)
		) {
			return refused(
				refuse(
					READBACK_MISMATCH,
					`${VERB}: the forfeit note landed but does not read back as sent — it needs a human eye. Nothing was removed.`,
					[input.scope],
				),
			);
		}
		if (issue.value.state !== "closed") {
			const closed = yield* closeCompleted(repo, input.spike);
			if (closed._tag === "Failure") {
				return refused(
					refuse(
						WRITE_UNKNOWN,
						`${VERB}: the forfeit note landed as comment ${posted.value.id} but the close failed: ${closed.reason} — the note IS on the record; re-run to close. Nothing was removed.`,
						[input.scope],
					),
				);
			}
		}
		return {_tag: "Ok", forfeited: true};
	});
