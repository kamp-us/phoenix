/**
 * The checks every `spike` verb runs before it decides anything, factored here so five verbs cannot
 * disagree about what an off-grammar nonce is, what an absent workspace is, or what a leak is.
 *
 * Each returns the refusal itself rather than a boolean, so a caller cannot receive "this failed" and
 * then compose a message that drifts from the code it seats.
 *
 * **Absence and unreadability are separated at every read here**, because that is the split the whole
 * group rests on: an absent workspace is `12`, an absent evidence log is a *fact*, and a read that
 * could not be performed is `11` with nothing written.
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {exists, readFile} from "../io/fs.ts";
import {treeStatus} from "../io/git.ts";
import {resolveRepo} from "../io/issues.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	BARE_AT_PATH,
	LEAKED_PATH,
	MALFORMED_RECORD,
	NO_WORKSPACE,
	OFF_VOCABULARY,
	READ_OR_EXEC_UNKNOWN,
} from "./codes.ts";
import {
	differingStatusLines,
	type EvidenceRecord,
	evidenceDigestOf,
	evidencePath,
	isNonce,
	type Manifest,
	manifestPath,
	parseEvidence,
	parseManifest,
	treeDigestOf,
} from "./workspace.ts";

export type Guarded<A> =
	| {readonly _tag: "Ok"; readonly value: A}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

export const ok = <A>(value: A): Guarded<A> => ({_tag: "Ok", value});
export const refused = (outcome: VerbOutcome): Guarded<never> => ({_tag: "Refused", outcome});

/** Anything in this module: it reads disk and shells out, so it needs both platform seams. */
export type SpikeEffect<A> = Effect.Effect<
	A,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
>;

/** The target repository, or the usage refusal that names both ways to supply it. */
export const targetRepo = (
	verb: string,
	explicit: string | null,
	env: Readonly<Record<string, string | undefined>>,
): Effect.Effect<Guarded<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const attempt = yield* resolveRepo(explicit, env);
		return attempt._tag === "Ok"
			? ok(attempt.value)
			: refused(
					refuse(
						FAILED,
						`${verb}: cannot resolve a target repo — pass --repo, or run inside a checkout whose origin remote resolves.`,
					),
				);
	});

/** The `10` a nonce that is not eight lowercase hex earns, in each verb's own words. */
export const nonceGrammar = (verb: string, nonce: string, tail: string): VerbOutcome | null =>
	isNonce(nonce)
		? null
		: refuse(
				OFF_VOCABULARY,
				`${verb}: --nonce "${nonce}" is not eight lowercase hex characters.${tail}`,
			);

/**
 * Every text this group sends to GitHub is leak-scanned before the write.
 *
 * The recorded false positive is inherited rather than designed around: the scan flags a
 * counter-example path quoted in prose (#3785), so a decision body that *quotes* a path refuses on
 * `5`. The expectation is that a decision describes what a path was rather than pasting one — which
 * is also what keeps a machine-local path out of a posted body in the first place.
 */
export const leakFree = (verb: string, what: string, text: string): VerbOutcome | null => {
	if (isBareAtReference(text)) {
		return refuse(
			BARE_AT_PATH,
			`${verb}: the ${what} is a bare @ path reference — write the text, not a pointer to it.`,
		);
	}
	const scan = scanBody(text);
	return scan.leaks.length === 0
		? null
		: refuse(
				LEAKED_PATH,
				`${verb}: the ${what} carries a machine-local path: ${scan.leaks[0]?.text ?? "<unnamed>"}.`,
				renderLeaks(scan.leaks),
			);
};

/** Whether a path is there — a probe that could not be performed is `11`, never "absent". */
export const probe = (verb: string, what: string, path: string): SpikeEffect<Guarded<boolean>> =>
	exists(path).pipe(
		Effect.map(ok<boolean>),
		Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
			Effect.succeed(
				refused(
					refuse(
						READ_OR_EXEC_UNKNOWN,
						`${verb}: cannot read ${what}: ${failure.reason} — nothing was written and the state is UNKNOWN.`,
					),
				),
			),
		),
	);

/** The manifest for a nonce: `12` when the workspace is absent, `4` malformed, `11` unreadable. */
export const readManifest = (
	verb: string,
	workspace: string,
	nonce: string,
	absentTail: string,
): SpikeEffect<Guarded<Manifest>> =>
	Effect.gen(function* () {
		const present = yield* probe(verb, "the workspace", workspace);
		if (present._tag === "Refused") return present;
		if (!present.value) {
			return refused(
				refuse(NO_WORKSPACE, `${verb}: no workspace for nonce ${nonce} — ${absentTail}`),
			);
		}
		const path = manifestPath(workspace);
		const read = yield* readFile(path).pipe(
			Effect.map((text) => ({_tag: "Text" as const, text})),
			Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
				Effect.succeed({_tag: "Failed" as const, reason: failure.reason}),
			),
		);
		if (read._tag === "Failed") {
			return refused(
				refuse(
					READ_OR_EXEC_UNKNOWN,
					`${verb}: cannot read the manifest for nonce ${nonce}: ${read.reason} — nothing was written.`,
				),
			);
		}
		const manifest = parseManifest(read.text);
		return manifest._tag === "Malformed"
			? refused(
					refuse(
						MALFORMED_RECORD,
						`${verb}: ${path} exists but does not satisfy the manifest schema: ${manifest.reason} — refusing the whole file.`,
					),
				)
			: ok(manifest.value);
	});

/** The evidence log as it sits on disk, plus the digest taken over exactly those bytes. */
export interface Evidence {
	readonly records: ReadonlyArray<EvidenceRecord>;
	/** The log's bytes as text, or `null` when the log was never written — a fact, not a failed read. */
	readonly text: string | null;
	/** `null` when the log was never written: a log that does not exist is not one that hashes empty. */
	readonly digest: string | null;
}

/**
 * The evidence log for a workspace.
 *
 * An **absent** log is a fact — zero runs, `seq` 1 for the next append — and is deliberately not the
 * same value as an empty one: `digest` is `null` rather than the SHA-256 of zero bytes, so no caller
 * can compare a never-written log against a marker and read the two as agreeing.
 */
export const readEvidence = (verb: string, workspace: string): SpikeEffect<Guarded<Evidence>> =>
	Effect.gen(function* () {
		const path = evidencePath(workspace);
		const present = yield* probe(verb, "the evidence log", path);
		if (present._tag === "Refused") return present;
		if (!present.value) return ok<Evidence>({records: [], text: null, digest: null});
		const read = yield* readFile(path).pipe(
			Effect.map((text) => ({_tag: "Text" as const, text})),
			Effect.catchTag("fabrika-cli/ReadFailed", (failure) =>
				Effect.succeed({_tag: "Failed" as const, reason: failure.reason}),
			),
		);
		if (read._tag === "Failed") {
			return refused(
				refuse(
					READ_OR_EXEC_UNKNOWN,
					`${verb}: cannot read the evidence log: ${read.reason} — the log is the evidence, so a log that cannot be read proves nothing.`,
				),
			);
		}
		const log = parseEvidence(read.text);
		return log._tag === "Malformed"
			? refused(
					refuse(
						MALFORMED_RECORD,
						`${verb}: ${path} does not parse: ${log.reason} — the log is the evidence, so a log that cannot be read proves nothing.`,
					),
				)
			: ok<Evidence>({
					records: log.value,
					text: read.text,
					digest: evidenceDigestOf(read.text),
				});
	});

/** The working tree's state at `root`, digested — and the sorted status lines a `17` enumerates. */
export interface TreeState {
	readonly digest: string;
	readonly lines: ReadonlyArray<string>;
}

export const readTree = (verb: string, root: string): SpikeEffect<Guarded<TreeState>> =>
	Effect.gen(function* () {
		const status = yield* treeStatus(root);
		return status._tag === "Failure"
			? refused(
					refuse(
						READ_OR_EXEC_UNKNOWN,
						`${verb}: cannot read the tree state at ${root}: ${status.reason} — an unreadable tree is UNKNOWN, never clean.`,
					),
				)
			: ok<TreeState>({
					digest: treeDigestOf(status.value),
					lines: differingStatusLines(status.value),
				});
	});
