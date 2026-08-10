/**
 * `spike run` — execute one command in the workspace and append an immutable evidence record.
 *
 * **Exit `0` means the command was executed and recorded, not that it succeeded.** The command's own
 * status rides in the payload as `commandExit`, where a caller reads it as data. This is the one
 * place in the group where the exit code and the answer are deliberately about different things: a
 * prototype that ran and answered **no** is `0` with a non-zero `commandExit`, and a prototype that
 * could not run is `11` and answers nothing. Those are opposite answers, and the shipped helpers make
 * the correct shape the only constructible one — `answer` hardcodes code `0`, so a payload carrying
 * `commandExit` cannot ride a non-zero code.
 *
 * **An absent evidence log is a fact** (`seq` 1), not a failed read. This verb surveys nothing, so it
 * has no zero-scope case at all.
 *
 * **The child's environment is built, never inherited.** It receives `PATH`, `HOME`, `LANG`,
 * `LC_ALL`, `TZ` and `TMPDIR`, plus every `--env` pair, plus `SPIKE_WORKSPACE`. Everything else is
 * dropped, and naming a credential variable explicitly in `--env` is refused rather than honoured —
 * a prototype is throwaway code nobody reviewed, so handing it the token that can write to the board
 * would make this the widest hole in fabrika rather than its most bounded execution point.
 *
 * **The captured bytes are what is stored.** Streams are written first and the record line last, so a
 * record never names files that do not exist, and `outBytes` counts what was stored rather than what
 * the child produced — past the bound nothing further is read, so a pre-truncation total is not
 * knowable and no field claims to hold one.
 */

import {Effect} from "effect";
import type {ChildRunner} from "../io/exec.ts";
import {appendText, writeBytes} from "../io/fs.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {OFF_VOCABULARY, READ_OR_EXEC_UNKNOWN, WORKSPACE_IN_TREE} from "./codes.ts";
import {nonceGrammar, readEvidence, readManifest, type SpikeEffect} from "./guards.ts";
import {
	CAPTURE_BYTES,
	captureErrPath,
	captureOutPath,
	type EvidenceRecord,
	evidencePath,
	isInsideTree,
	renderEvidenceLine,
	sha256Of,
	workspacePath,
} from "./workspace.ts";

export interface RunOptions {
	readonly nonce: string;
	readonly timeout: number;
	/** `KEY=VALUE` pairs added to the scrubbed environment. */
	readonly env: ReadonlyArray<string>;
	/** The literal argv after `--`, taken as-is and never passed through a shell. */
	readonly command: ReadonlyArray<string>;
	readonly parentEnv: Readonly<Record<string, string | undefined>>;
	readonly tmpRoot: string;
	/** The execution seam, injected so a timeout and an unstartable binary are both testable. */
	readonly spawn: ChildRunner;
}

const VERB = "spike run";

/** The only parent variables a child inherits. Everything else is dropped, credentials included. */
export const PASSED_THROUGH = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"] as const;

const ENV_PAIR_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

/**
 * Whether a variable name may not be handed to a prototype.
 *
 * A **generic** shape check, never a named deny-list: the point is that a credential cannot reach a
 * child by any name that looks like one, and a list of the tokens we happen to know about would go
 * stale the first time a new one is minted.
 */
export const isCredentialName = (name: string): boolean =>
	name === "GH_TOKEN" ||
	name === "GITHUB_TOKEN" ||
	name.endsWith("_TOKEN") ||
	name.endsWith("_SECRET") ||
	name.endsWith("_KEY");

/** The child's whole environment, or the name of the `--env` pair that is refused. */
export const childEnv = (input: {
	readonly parentEnv: Readonly<Record<string, string | undefined>>;
	readonly pairs: ReadonlyArray<string>;
	readonly workspace: string;
}):
	| {readonly _tag: "Env"; readonly env: Record<string, string>}
	| {readonly _tag: "Refused"; readonly pair: string} => {
	const env: Record<string, string> = {};
	for (const name of PASSED_THROUGH) {
		const value = input.parentEnv[name];
		if (value !== undefined) env[name] = value;
	}
	for (const pair of input.pairs) {
		const match = ENV_PAIR_RE.exec(pair);
		if (match?.[1] === undefined || match[2] === undefined || isCredentialName(match[1])) {
			return {_tag: "Refused", pair};
		}
		env[match[1]] = match[2];
	}
	env.SPIKE_WORKSPACE = input.workspace;
	return {_tag: "Env", env};
};

export const runRun = (options: RunOptions): SpikeEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const grammar = nonceGrammar(VERB, options.nonce, "");
		if (grammar !== null) return grammar;
		if (options.command.length === 0) {
			return refuse(
				FAILED,
				`${VERB}: no command was given after -- — there is nothing to run and nothing to record.`,
			);
		}
		if (!Number.isInteger(options.timeout) || options.timeout <= 0) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --timeout "${options.timeout}" is not a positive integer.`,
			);
		}

		const workspace = workspacePath(options.tmpRoot, options.nonce);
		const manifest = yield* readManifest(
			VERB,
			workspace,
			options.nonce,
			"open a spike first, or this run was already disposed.",
		);
		if (manifest._tag === "Refused") return manifest.outcome;
		if (isInsideTree(workspace, manifest.value.treeRoot)) {
			return refuse(
				WORKSPACE_IN_TREE,
				`${VERB}: the workspace ${workspace} resolves inside the repository at ${manifest.value.treeRoot} — refusing to execute against the tree.`,
			);
		}

		const evidence = yield* readEvidence(VERB, workspace);
		if (evidence._tag === "Refused") return evidence.outcome;
		const seq = evidence.value.records.length + 1;

		const built = childEnv({
			parentEnv: options.parentEnv,
			pairs: options.env,
			workspace,
		});
		if (built._tag === "Refused") {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --env "${built.pair}" is not KEY=VALUE, or names a credential variable a prototype may not receive.`,
			);
		}

		const scope = `${VERB}: nonce ${options.nonce}, run ${seq}, ${options.command.length} argv token(s), timeout ${options.timeout}s.`;
		const file = options.command[0] ?? "";
		const outcome = yield* options.spawn({
			file,
			args: options.command.slice(1),
			cwd: workspace,
			env: built.env,
			timeoutSeconds: options.timeout,
			captureBytes: CAPTURE_BYTES,
		});
		if (outcome._tag === "Unstartable") {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: the command could not be executed: ${outcome.reason} — nothing was recorded, and this is NOT an answer of no.`,
				[scope],
			);
		}

		const wroteOut = yield* writeCapture(captureOutPath(workspace, seq), outcome.stdout);
		const wroteErr =
			wroteOut === null
				? yield* writeCapture(captureErrPath(workspace, seq), outcome.stderr)
				: null;
		const writeFailure = wroteOut ?? wroteErr;
		if (writeFailure !== null) {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot write the capture files for run ${seq}: ${writeFailure} — nothing was appended.`,
				[scope],
			);
		}

		const record: EvidenceRecord = {
			seq,
			command: [...options.command],
			commandExit: outcome.exitCode,
			timedOut: outcome.timedOut,
			outBytes: outcome.stdout.length,
			errBytes: outcome.stderr.length,
			truncated: outcome.truncated,
			outSha256: sha256Of(outcome.stdout),
			errSha256: sha256Of(outcome.stderr),
		};
		const appended = yield* appendText(evidencePath(workspace), renderEvidenceLine(record)).pipe(
			Effect.map((): string | null => null),
			Effect.catchTag("fabrika-cli/WriteFailed", (failure) => Effect.succeed(failure.reason)),
		);
		if (appended !== null) {
			return refuse(
				READ_OR_EXEC_UNKNOWN,
				`${VERB}: cannot write the capture files for run ${seq}: ${appended} — nothing was appended.`,
				[scope],
			);
		}

		return answer(JSON.stringify({nonce: options.nonce, ...record}), [scope]);
	});

const writeCapture = (path: string, bytes: Uint8Array): SpikeEffect<string | null> =>
	writeBytes(path, bytes).pipe(
		Effect.map((): string | null => null),
		Effect.catchTag("fabrika-cli/WriteFailed", (failure) => Effect.succeed(failure.reason)),
	);
