/**
 * `spike open` — mint the spike issue for one question, allocate this run's workspace under a freshly
 * minted nonce, and bind the two in a manifest.
 *
 * Not a judging verb: it supplies an identity. Whether this question deserves a spike stays in the
 * skill; what this verb proves is mechanical — the path is outside the tree, the label exists, the
 * issue read back as sent, and the workspace names it.
 *
 * **Three ordering rules are load-bearing and none is incidental.** The in-tree refusal comes before
 * any write, so a workspace inside the tree never becomes part of the thing the digest measures. The
 * tree digest is taken before the workspace exists, for the same reason. And the workspace is created
 * **before** the issue, so a half-applied run fails toward a local orphan directory `spike dispose`
 * collects rather than toward a public issue nobody holds a nonce for.
 *
 * **An absent workspace is the normal first-run path, not a refusal** — which is why this verb seats
 * `4` for a manifest that does not parse and never `12` for one that is not there, the asymmetry its
 * sibling verbs invert.
 */

import {Effect} from "effect";
import {exists, readFile, realPath, writeFile} from "../io/fs.ts";
import {repoRoot, treeStatus} from "../io/git.ts";
import {createIssue, getIssue, listLabels, openIssuesWithLabel} from "../io/issues.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {issueBody, SPIKE_LABEL, spikeTitle} from "./bodies.ts";
import {
	MALFORMED_RECORD,
	MANIFEST_INCOMPLETE,
	NO_WORKSPACE,
	OFF_VOCABULARY,
	READ_OR_EXEC_UNKNOWN,
	READBACK_MISMATCH,
	WORKSPACE_IN_TREE,
	WORKSPACE_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {leakFree, nonceGrammar, type SpikeEffect, targetRepo} from "./guards.ts";
import {
	isInsideTree,
	isKind,
	isNonce,
	KINDS,
	type Kind,
	type Manifest,
	manifestPath,
	parseManifest,
	renderManifest,
	treeDigestOf,
	workspacePath,
} from "./workspace.ts";

export interface OpenOptions {
	readonly question: string;
	readonly kind: string;
	readonly ticket: number | null;
	/** Re-entry only: names an existing workspace to resume. A caller does not invent one. */
	readonly nonce: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The OS temp root — the one machine fact this group does not derive, read by the adapter. */
	readonly tmpRoot: string;
	/** The cryptographic source a fresh nonce is drawn from, injected so a test can pin the value. */
	readonly mintNonce: () => string;
}

const VERB = "spike open";

const answered = (manifest: Manifest, workspace: string, scope: string): VerbOutcome =>
	answer(
		JSON.stringify({
			spike: manifest.spike,
			nonce: manifest.nonce,
			kind: manifest.kind,
			workspace,
			treeDigest: manifest.treeDigest,
		}),
		[scope],
	);

export const runOpen = (options: OpenOptions): SpikeEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const question = options.question.trim();
		if (question === "") {
			return refuse(FAILED, `${VERB}: --question is empty — a spike answers one named question.`);
		}
		if (!isKind(options.kind)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --kind "${options.kind}" is not ${KINDS.join(" or ")} — those are the two ruled artifact shapes (#5017).`,
			);
		}
		const kind: Kind = options.kind;
		if (options.nonce !== null && !isNonce(options.nonce)) {
			return (
				nonceGrammar(
					VERB,
					options.nonce,
					" Nonces are minted by this verb, not supplied, except to re-enter a run.",
				) ?? refuse(FAILED, `${VERB}: --nonce could not be validated.`)
			);
		}

		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return target.outcome;
		const repo = target.value;

		const root = yield* repoRoot;
		if (root._tag === "Failure") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read the repository root: ${root.reason} — nothing was minted and no workspace exists.`,
			);
		}
		// Serial on purpose: two local `realpath` calls, and the refusal below names whichever failed
		// first, which a concurrent pair would make nondeterministic.
		const resolved = yield* Effect.all([realPath(root.value), realPath(options.tmpRoot)], {
			concurrency: 1,
		}).pipe(
			Effect.map(([treeRoot, tmpRoot]) => ({_tag: "Ok" as const, treeRoot, tmpRoot})),
			Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
				Effect.succeed({_tag: "Failed" as const, what: failure.path, reason: failure.reason}),
			),
		);
		if (resolved._tag === "Failed") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read ${resolved.what}: ${resolved.reason} — nothing was minted and no workspace exists.`,
			);
		}
		const {treeRoot, tmpRoot} = resolved;

		const nonce = options.nonce ?? options.mintNonce();
		const workspace = workspacePath(tmpRoot, nonce);
		if (isInsideTree(workspace, treeRoot)) {
			return refuse(
				WORKSPACE_IN_TREE,
				`${VERB}: the workspace path ${workspace} resolves inside the repository at ${treeRoot} — a spike that lives in the tree is the defect this skill exists to prevent. Nothing was written.`,
			);
		}

		const scope = `${VERB}: ${repo}, nonce ${nonce}, workspace ${workspace}, tree ${treeRoot}.`;

		const present = yield* exists(workspace).pipe(
			Effect.map((value) => ({_tag: "Ok" as const, value})),
			Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
				Effect.succeed({_tag: "Failed" as const, reason: failure.reason}),
			),
		);
		if (present._tag === "Failed") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read the workspace: ${present.reason} — nothing was minted and no workspace exists.`,
			);
		}
		if (present.value) {
			return yield* resumeExisting({repo, workspace, nonce, question, kind, scope});
		}
		if (options.nonce !== null) {
			return refuse(
				NO_WORKSPACE,
				`${VERB}: --nonce ${nonce} names no workspace — omit it to mint a new run.`,
			);
		}

		const labels = yield* listLabels(repo);
		if (labels._tag === "Failure") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read the label set of ${repo}: ${labels.reason} — nothing was minted and no workspace exists.`,
			);
		}
		if (!labels.value.includes(SPIKE_LABEL)) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: the repository has no ${SPIKE_LABEL} label — a spike minted without it is one no later run and no caller can find. Run /fabrika: front-door's bootstrap creates the board labels (#4952).`,
			);
		}

		const status = yield* treeStatus(treeRoot);
		if (status._tag === "Failure") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read the tree state at ${treeRoot}: ${status.reason} — nothing was minted and no workspace exists.`,
			);
		}
		const treeDigest = treeDigestOf(status.value);

		const provisional: Manifest = {
			spike: null,
			nonce,
			kind,
			question,
			repo,
			ticket: options.ticket,
			treeDigest,
			treeRoot,
		};
		const staged = yield* writeManifest(workspace, provisional);
		if (staged !== null) {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot write the workspace at ${workspace}: ${staged} — nothing was minted.`,
				[scope],
			);
		}

		const title = spikeTitle(question);
		const body = issueBody({question, kind, nonce, ticket: options.ticket});
		const leaked = leakFree(VERB, "composed title", title) ?? leakFree(VERB, "composed body", body);
		if (leaked !== null) return {...leaked, stderr: [scope, ...leaked.stderr]};

		const created = yield* createIssue(repo, title, body, SPIKE_LABEL);
		if (created._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the issue create failed: ${created.reason} — it may or may not have landed; read the board before re-running.`,
				[scope],
			);
		}
		const spike = created.value.number;

		const landed = yield* getIssue(repo, spike);
		if (landed._tag !== "Present") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: the issue create failed: ${landed._tag === "Absent" ? `#${spike} is not readable after the create` : landed.reason} — it may or may not have landed; read the board before re-running.`,
				[scope],
			);
		}
		const wrong =
			landed.value.title !== title
				? "title"
				: normalizeForReadback(landed.value.body) !== normalizeForReadback(body)
					? "body"
					: landed.value.labels.includes(SPIKE_LABEL)
						? null
						: "labels";
		if (wrong !== null) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: the spike landed as #${spike} but its ${wrong} does not read back as sent — it needs a human eye.`,
				[scope],
			);
		}

		const completed: Manifest = {...provisional, spike};
		const failure = yield* writeManifest(workspace, completed);
		if (failure !== null) {
			return refuse(
				MANIFEST_INCOMPLETE,
				`${VERB}: the spike landed as #${spike} but its manifest could not be completed: ${failure} — the issue exists and no workspace names it. Close #${spike}, or re-run with --nonce ${nonce}.`,
				[scope],
			);
		}
		return answered(completed, workspace, scope);
	});

const writeManifest = (workspace: string, manifest: Manifest): SpikeEffect<string | null> =>
	writeFile(manifestPath(workspace), renderManifest(manifest)).pipe(
		Effect.map((): string | null => null),
		Effect.catchTag("fabrika-cli/WriteFailed", (failure) => Effect.succeed(failure.reason)),
	);

/**
 * The re-entry branch: a workspace already exists for this nonce.
 *
 * Every path here either answers the existing manifest or refuses — a workspace that exists and
 * holds different work is never written over, and a re-run after a network fault therefore mints no
 * second issue.
 */
const resumeExisting = (input: {
	readonly repo: string;
	readonly workspace: string;
	readonly nonce: string;
	readonly question: string;
	readonly kind: Kind;
	readonly scope: string;
}): SpikeEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const path = manifestPath(input.workspace);
		const read = yield* readFile(path).pipe(
			Effect.map((text) => ({_tag: "Text" as const, text})),
			Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
				Effect.succeed({_tag: "Failed" as const, reason: failure.reason}),
			),
		);
		if (read._tag === "Failed") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read the manifest for nonce ${input.nonce}: ${read.reason} — nothing was minted.`,
			);
		}
		const manifest = parseManifest(read.text);
		if (manifest._tag === "Malformed") {
			return refuse(
				MALFORMED_RECORD,
				`${VERB}: a workspace for nonce ${input.nonce} exists but its manifest does not parse: ${manifest.reason} — refusing the whole file; re-entry cannot be decided against half a manifest.`,
			);
		}
		if (manifest.value.question !== input.question) {
			return refuse(
				WORKSPACE_MISMATCH,
				`${VERB}: a workspace for nonce ${input.nonce} holds a different question — mint a new run rather than reusing it.`,
			);
		}
		if (manifest.value.kind !== input.kind) {
			return refuse(
				WORKSPACE_MISMATCH,
				`${VERB}: a workspace for nonce ${input.nonce} holds a different kind — mint a new run rather than reusing it.`,
			);
		}
		if (manifest.value.spike !== null)
			return answered(manifest.value, input.workspace, input.scope);

		// A provisional manifest is a real, reachable state: the issue landed and the completing write
		// did not (`20`). The way forward is to find that issue by the nonce its body carries, which is
		// what makes `20`'s named recovery terminate instead of loop.
		const listed = yield* openIssuesWithLabel(input.repo, SPIKE_LABEL);
		if (listed._tag === "Failure") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot read the open ${SPIKE_LABEL} issues of ${input.repo}: ${listed.reason} — the manifest stays provisional and nothing was lost.`,
			);
		}
		for (const row of listed.value) {
			const issue = yield* getIssue(input.repo, row.number);
			if (issue._tag === "Unknown") {
				return refuse(
					READ_OR_EXEC_UNKNOWN,
					`${VERB}: cannot read spike #${row.number}: ${issue.reason} — the manifest stays provisional and nothing was lost.`,
				);
			}
			if (issue._tag === "Absent") continue;
			if (!issueBodyNames(issue.value.body, input.nonce)) continue;
			const completed: Manifest = {...manifest.value, spike: row.number};
			const failure = yield* writeManifest(input.workspace, completed);
			return failure === null
				? answered(completed, input.workspace, input.scope)
				: refuse(
						MANIFEST_INCOMPLETE,
						`${VERB}: the spike landed as #${row.number} but its manifest could not be completed: ${failure} — the issue exists and no workspace names it. Close #${row.number}, or re-run with --nonce ${input.nonce}.`,
					);
		}
		return refuse(
			NO_WORKSPACE,
			`${VERB}: --nonce ${input.nonce} names a workspace whose spike is not among the open ${SPIKE_LABEL} issues — the workspace names nothing. Omit --nonce to start over.`,
		);
	});

/** Whether an issue body's `## Run` section names this nonce. */
const issueBodyNames = (body: string, nonce: string): boolean =>
	body
		.split("\n")
		.map((line) => line.trim())
		.includes(nonce);
