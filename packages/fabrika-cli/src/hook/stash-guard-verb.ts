/**
 * `hook stash-guard` — refuse `git stash` in a linked worktree, where the stash stack is shared.
 *
 * The decision is `./git-stash.ts`; this file routes the envelope and runs the one git probe, and
 * only when the command runs `git stash` at all, so every other Bash call costs no subprocess.
 *
 * The verdict rides JSON at exit 0 (`./pre-tool-use.ts`). Every state in which nothing was judged —
 * an unreadable envelope, a cwd git cannot read, a probe that fails or times out — exits on a
 * non-blocking code with stderr saying the guard did not run, so the command proceeds and the user
 * sees why.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/6844#issuecomment-5519865462
 */
import {isAbsolute} from "node:path";
import {Effect} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {execRecord} from "../io/exec.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	EMPTY_STDIN,
	ENVELOPE_UNKNOWN,
	GROUND_UNKNOWN,
	MALFORMED_ENVELOPE,
	WRONG_EVENT,
} from "./codes.ts";
import {classifyEnvelope, type EnvelopeRead} from "./envelope.ts";
import {decideStash, findGitStash, GIT_DIRS_ARGS, readGitDirs} from "./git-stash.ts";
import {bashCommandOf, preToolUseStdout} from "./pre-tool-use.ts";
import {childEnv} from "./worktree-create.ts";

const VERB = "fabrika hook stash-guard";

/** The event and tool this verb judges. Anything else is a mis-wired declaration, not a payload bug. */
const EVENT = "PreToolUse";
const TOOL = "Bash";

/** Well inside the declaration's 10s hook budget, so a hung git ends here rather than in the harness. */
export const GIT_TIMEOUT_SECONDS = 5;
const CAPTURE_BYTES = 16 * 1024;

const NOT_RUN = "the stash guard did NOT run, and the command proceeds unguarded";

export interface StashGuardOptions {
	readonly stdin: Effect.Effect<StdinRead>;
	readonly env: Record<string, string | undefined>;
}

const readEnvelope = (piped: StdinRead): EnvelopeRead =>
	piped._tag === "Text" ? classifyEnvelope(piped.text) : {_tag: "Unknown", reason: piped.reason};

const stdinScope = (piped: StdinRead): string =>
	piped._tag === "Text"
		? `${VERB}: judged ${piped.text.length} bytes on fd 0`
		: `${VERB}: judged nothing — fd 0 was not read`;

export const runStashGuard = ({
	stdin,
	env,
}: StashGuardOptions): Effect.Effect<VerbOutcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const piped = yield* stdin;
		const scope = stdinScope(piped);
		const read = readEnvelope(piped);

		if (read._tag === "Empty") {
			return refuse(EMPTY_STDIN, `${VERB}: stdin was read and held nothing — ${NOT_RUN}.`, [scope]);
		}
		if (read._tag === "Unknown") {
			return refuse(ENVELOPE_UNKNOWN, `${VERB}: envelope UNKNOWN (${read.reason}) — ${NOT_RUN}.`, [
				scope,
			]);
		}
		if (read._tag === "Malformed") {
			return refuse(
				MALFORMED_ENVELOPE,
				`${VERB}: not a hook envelope (${read.reason}) — ${NOT_RUN}.`,
				[scope, `${VERB}: ${read.evidence}`],
			);
		}

		const envelope = read.envelope;
		if (envelope.event !== EVENT) {
			return refuse(
				WRONG_EVENT,
				`${VERB}: judges ${EVENT}/${TOOL} and the envelope carries ${envelope.event} — the declaration is wired to an event this verb does not judge.`,
				[scope],
			);
		}
		const command = bashCommandOf(envelope);
		if (command === undefined) {
			return refuse(
				WRONG_EVENT,
				`${VERB}: the ${EVENT} envelope carries no \`tool_input.command\` string, so no ${TOOL} command was judged — the declaration's matcher reached a tool this verb does not judge.`,
				[scope],
			);
		}

		const commandScope = `${VERB}: judged \`${command}\` for a \`git stash\``;
		const stash = findGitStash(command);
		if (stash._tag === "None") {
			return answer(
				preToolUseStdout("hook stash-guard", {
					_tag: "Allow",
					because: "the command runs no git stash",
				}),
				[commandScope, `${VERB}: allow — no simple command on the line is a git stash`],
			);
		}

		const cwdScope = `${commandScope}, run in ${envelope.cwd}`;
		if (!isAbsolute(envelope.cwd)) {
			return refuse(
				GROUND_UNKNOWN,
				`${VERB}: the envelope's cwd \`${envelope.cwd}\` is not an absolute path, so which checkout the stash runs in is unknown — ${NOT_RUN}.`,
				[cwdScope],
			);
		}
		const probe = yield* execRecord({
			file: "git",
			args: GIT_DIRS_ARGS,
			cwd: envelope.cwd,
			env: childEnv(env),
			timeoutSeconds: GIT_TIMEOUT_SECONDS,
			captureBytes: CAPTURE_BYTES,
		});
		const dirs = readGitDirs(probe, GIT_TIMEOUT_SECONDS);
		if (dirs._tag === "Unread") {
			return refuse(
				GROUND_UNKNOWN,
				`${VERB}: cannot read the git dirs of ${envelope.cwd}: ${dirs.reason} — ${NOT_RUN}.`,
				[cwdScope],
			);
		}

		const decision = decideStash(stash.invocation, dirs.dirs);
		return answer(preToolUseStdout("hook stash-guard", decision), [
			`${cwdScope}, whose git dir is ${dirs.dirs.gitDir} and common dir ${dirs.dirs.commonDir}`,
			decision._tag === "Deny"
				? `${VERB}: deny — ${decision.reason}`
				: `${VERB}: allow — ${decision.because}`,
		]);
	});
