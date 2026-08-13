/**
 * `build commit` — create this lane's commit from a message the lane authored, and prove the commit
 * carries it.
 *
 * The verb exists because the group had **no commit verb at all**, so the message-carrying path at
 * every call site was improvised and nothing asserted the message on the resulting commit. A lane
 * improvised `git commit -F <scratch leaf>`, the leaf held a two-day-old message from another lane,
 * and the commit landed claiming an issue this lane had never touched — silently, with every command
 * exiting 0 (#5484).
 *
 * Three guards, each closing one half of that:
 *
 * - **The carrying path is prescribed, not improvised.** The message arrives on stdin (file-free) or
 *   in a leaf under `build scratch`'s claim-nonce-keyed directory. A hand-rolled path is refused
 *   (`10`), never tolerated — a path outside the allocator is exactly the one with no per-lane key.
 * - **The message may name only numbers this lane holds** (`4`). The borrowed message was
 *   well-formed and referenced a real issue, which is why a shape check cannot see it and a claim
 *   test can.
 * - **The message is read back off the created commit** (`9`). Everything upstream is a claim about
 *   what was *sent*; only `git log` says what git *recorded*, and the two differed in the incident.
 */
import {Effect, FileSystem} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {leakRefusal, readAuthored} from "./authored.ts";
import {requireSession} from "./claim.ts";
import {
	BAD_SECTIONS,
	COMMIT_NOT_CREATED,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
	ZERO_SCOPE,
} from "./codes.ts";
import {
	foreignRefsIn,
	isLaneScratchLeaf,
	leafOf,
	quotedBlock,
	redact,
	subjectOf,
} from "./commit-message.ts";
import {commitFromFile, commitFromStdin, commitMessage, headSha, stagedPaths} from "./git.ts";
import {laneNumber} from "./lane.ts";
import {requireLane} from "./lane-guard.ts";
import {closingTargets, proseOf} from "./pr-body.ts";
import {laneScratchDir} from "./scratch-verb.ts";
import {openPull, resolveTargetRepo} from "./target.ts";

const VERB = "build commit";

const SURFACE = {
	verb: VERB,
	emptyMessage: `${VERB}: stdin held nothing — the commit message is the input.`,
	bareAtMessage: `${VERB}: the message is a bare @ path reference — send the message, not a pointer to it.`,
};

export interface CommitOptions {
	/** A leaf under this lane's `build scratch` directory, or `null` to read the message from stdin. */
	readonly messageFile: string | null;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdin: Effect.Effect<StdinRead>;
	/** The OS temp root, read by the adapter — the one machine fact the allocator does not derive. */
	readonly tmpRoot: string;
}

type Message =
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome}
	| {readonly _tag: "Message"; readonly text: string};

export const runCommit = (
	options: CommitOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const session = requireSession(VERB, options.env);
		if (session._tag === "Refused") return session.outcome;

		const resolved = yield* resolveTargetRepo(VERB, options.repo, options.env);
		if (resolved._tag === "Refused") return resolved.outcome;
		const repo = resolved.repo;

		const lane = yield* requireLane(VERB, repo, session.id, null);
		if (lane._tag === "Refused") return lane.outcome;
		const branch = lane.lane;
		const number = laneNumber(branch);
		const notes = lane.notes;

		const read: Message = yield* readMessage(options, session.id, number, branch.nonce, notes);
		if (read._tag === "Refused") return read.outcome;
		const message = read.text;

		const leaked = leakRefusal(VERB, message);
		if (leaked !== null) return leaked;

		// In resume mode the lane's number is the PR's, so the issue the PR itself closes is a number
		// this lane demonstrably serves — read off the PR, never taken on the message's word.
		const permitted = new Set([number]);
		if (branch._tag === "Resume") {
			const pr = branch.pr;
			const pull = yield* openPull(
				VERB,
				repo,
				pr,
				(reason) =>
					`${VERB}: cannot read PR #${pr}: ${reason} — the numbers this lane serves are UNKNOWN, nothing was committed.`,
			);
			if (pull._tag === "Refused") return pull.outcome;
			for (const target of closingTargets(proseOf(pull.pull.body))) permitted.add(target);
		}

		const foreign = foreignRefsIn(message, permitted);
		const first = foreign[0];
		if (first !== undefined) {
			return refuse(
				BAD_SECTIONS,
				`${VERB}: the message names #${first}, which this lane holds no confirmed claim on — this lane's claim is on #${number}. A commit message names only what this lane owns; a related reference belongs in the PR body.`,
				notes,
			);
		}

		const staged = yield* stagedPaths;
		if (staged._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the index: ${redact(staged.reason)} — nothing was committed.`,
				notes,
			);
		}
		if (staged.value.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: nothing is staged — there is no change to commit.`,
				notes,
			);
		}

		const before = yield* headSha;
		if (before._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve HEAD: ${redact(before.reason)} — nothing was committed.`,
				notes,
			);
		}

		const ran =
			options.messageFile === null
				? yield* commitFromStdin(message)
				: yield* commitFromFile(options.messageFile);

		const after = yield* headSha;
		if (after._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: git commit ran and HEAD could not be re-read: ${redact(after.reason)} — whether a commit exists is UNKNOWN.`,
				notes,
			);
		}
		if (after.value === before.value) {
			return refuse(
				COMMIT_NOT_CREATED,
				`${VERB}: git commit ran and HEAD did not move — no commit was created${
					ran._tag === "Failure" ? `: ${redact(ran.reason)}` : ""
				}.`,
				notes,
			);
		}

		const recorded = yield* commitMessage(after.value);
		if (recorded._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: commit ${short(after.value)} was created but its message could not be read back: ${redact(recorded.reason)} — what it carries is UNKNOWN.`,
				notes,
			);
		}
		if (normalizeForReadback(recorded.value) !== normalizeForReadback(message)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: commit ${short(after.value)} carries a message this lane did not author — amend it, then re-run. It needs a human eye.`,
				[
					...notes,
					`${VERB}: this lane authored:`,
					...quotedBlock(message),
					`${VERB}: commit ${short(after.value)} reads back:`,
					...quotedBlock(recorded.value),
				],
			);
		}

		return answer(
			JSON.stringify({
				answer: "committed",
				sha: after.value,
				subject: subjectOf(message),
				carried: options.messageFile === null ? "stdin" : "scratch-leaf",
			}),
			notes,
		);
	});

const short = (sha: string): string => sha.slice(0, 8);

/** The message, from stdin or from a path proven to be this lane's allocator's. */
const readMessage = (
	options: CommitOptions,
	session: string,
	number: number,
	nonce: string,
	notes: ReadonlyArray<string>,
): Effect.Effect<Message, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const path = options.messageFile;
		if (path === null) {
			const authored = readAuthored(SURFACE, yield* options.stdin);
			return authored._tag === "Refused"
				? {_tag: "Refused" as const, outcome: authored.outcome}
				: {_tag: "Message" as const, text: authored.text};
		}
		if (!isLaneScratchLeaf(path, laneScratchDir(options.tmpRoot, session, number, nonce))) {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					OFF_VOCABULARY,
					`${VERB}: --message-file "${leafOf(path)}" is not a leaf in this lane's scratch directory — send the message on stdin, or write it under the path "fabrika build scratch ${number} --slug <leaf>" prints. That path is machine-local, so it is not repeated here.`,
					notes,
				),
			};
		}
		const fs = yield* FileSystem.FileSystem;
		// A read that FAILED and a file that is EMPTY are different answers, so they never fold: the
		// first is UNKNOWN (`11`), the second is a proven defect in what the caller wrote (`4`).
		const attempt = yield* fs.readFileString(path).pipe(
			Effect.map((text) => ({_tag: "Read" as const, text})),
			Effect.catchTag("PlatformError", (cause) =>
				Effect.succeed({_tag: "Unreadable" as const, reason: cause.message}),
			),
		);
		if (attempt._tag === "Unreadable") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: --message-file "${leafOf(path)}" could not be read: ${redact(attempt.reason)} — the message is UNKNOWN, never empty.`,
					notes,
				),
			};
		}
		const text = attempt.text;
		return text.trim() === ""
			? {
					_tag: "Refused" as const,
					outcome: refuse(
						BAD_SECTIONS,
						`${VERB}: --message-file "${leafOf(path)}" holds no message — a commit message is the input.`,
						notes,
					),
				}
			: {_tag: "Message" as const, text};
	});
