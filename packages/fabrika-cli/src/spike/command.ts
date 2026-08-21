/**
 * The `spike` verb group — `fabrika spike <open|run|capture|dispose|status>`, the `prototyping`
 * skill's half of the ideation layer.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), reads the two machine facts this group does not derive — the OS
 * temp root and a cryptographic random source — runs the pure verb, and emits its outcome. Every
 * decision lives in the `*-verb.ts` modules beside it, which is what makes each refusal testable
 * without spawning a process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * **`--kind` is declared as a string and checked in the verb.** The check is the closed set's, and
 * seating it in the verb is what lets the refusal name the whole vocabulary and seat it on `10`
 * rather than emit the parser's generic message.
 */

import {randomBytes} from "node:crypto";
import {tmpdir} from "node:os";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {execRecord} from "../io/exec.ts";
import {readStdin} from "../io/stdin.ts";
import {runCapture} from "./capture-verb.ts";
import {runDispose} from "./dispose-verb.ts";
import {runOpen} from "./open-verb.ts";
import {runRun} from "./run-verb.ts";
import {runStatus} from "./status-verb.ts";
import {KINDS} from "./workspace.ts";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const nonceFlag = Flag.string("nonce").pipe(
	Flag.withDescription(
		"this run's key, eight lowercase hex characters — minted by `spike open` and passed verbatim, never invented by a caller",
	),
);

const open = leafCommand(
	"open",
	{
		question: Flag.string("question").pipe(
			Flag.withDescription(
				"the one named question this spike answers; two questions is two spikes",
			),
		),
		kind: Flag.string("kind").pipe(
			Flag.withDescription(`the ruled artifact shape: one of ${KINDS.join(", ")}`),
		),
		ticket: Flag.integer("ticket").pipe(
			Flag.optional,
			Flag.withDescription(
				"the issue this question came from, recorded as provenance and never read for instruction",
			),
		),
		nonce: Flag.string("nonce").pipe(
			Flag.optional,
			Flag.withDescription(
				"re-entry only: names an existing workspace to resume; supplying one with no workspace is 12",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({question, kind, ticket, nonce, repo}) {
		yield* emit(
			yield* runOpen({
				question,
				kind,
				ticket: Option.getOrNull(ticket),
				nonce: Option.getOrNull(nonce),
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
				mintNonce: () => randomBytes(4).toString("hex"),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Mint the spike issue and workspace for one question."),
	Command.withDescription(
		'Mint the spike issue for one question, allocate this run\'s workspace under a freshly minted nonce, and bind the two in a manifest. Prints {"spike":n,"nonce":"…","kind":"…","workspace":"…","treeDigest":"…"}. Exits 4 (a workspace exists and its manifest does not parse), 5/6 (machine-local path, bare @ reference), 7 (no prototyping:spike label), 8/9 (the create failed, the read-back differs), 10 (off-grammar --nonce or --kind), 11 (a root, the label set or the tree state could not be read — nothing was minted), 12 (--nonce names no workspace), 13 (the workspace resolves inside the repository), 18 (a workspace under a different question or kind), 20 (the spike landed and the manifest could not be completed). Example: fabrika spike open --question "does better-auth mint a single-use token without a new table?" --kind logic',
	),
);

const run = leafCommand(
	"run",
	{
		nonce: nonceFlag,
		timeout: Flag.integer("timeout").pipe(
			Flag.withDefault(300),
			Flag.withDescription(
				"seconds before the child's process group is killed; the run is still recorded, with timedOut true",
			),
		),
		env: Flag.string("env").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"KEY=VALUE added to the child's scrubbed environment; repeatable, and a credential variable is refused rather than honoured",
			),
		),
		command: Argument.string("command").pipe(
			Argument.atLeast(1),
			Argument.withDescription(
				"the argv to execute after --, taken literally and never passed through a shell",
			),
		),
	},
	Effect.fn(function* ({nonce, timeout, env, command}) {
		yield* emit(
			yield* runRun({
				nonce,
				timeout,
				env,
				command,
				parentEnv: process.env,
				tmpRoot: tmpdir(),
				spawn: execRecord,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Execute one command in the workspace and log the evidence."),
	Command.withDescription(
		'Execute one command in the workspace and append an immutable evidence record. Exit 0 means the command RAN and was recorded, whatever it returned — its own status rides in the payload as commandExit. Prints {"nonce":"…","seq":n,"command":[…],"commandExit":n,"timedOut":bool,"outBytes":n,"errBytes":n,"truncated":bool,"outSha256":"…","errSha256":"…"}. Exits 4 (the manifest or the log does not parse, or the log is not contiguous from 1), 10 (off-grammar --nonce, --timeout or --env), 11 (the command could NOT be executed — nothing was appended, and this is not an answer of no), 12 (no workspace for this nonce), 13 (the workspace resolves inside the repository). Example: fabrika spike run --nonce 7f3a9c21 -- node walkthrough.mjs',
	),
);

const capture = leafCommand(
	"capture",
	{
		spike: Argument.integer("spike").pipe(
			Argument.withDescription("the spike issue the decision is captured on"),
		),
		nonce: nonceFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({spike, nonce, repo}) {
		yield* emit(
			yield* runCapture({
				spike,
				nonce,
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the decision on stdin with the run table, then close."),
	Command.withDescription(
		'Post the decision read from STDIN plus the log\'s own run table, read it back, and close the spike. Prints {"spike":n,"nonce":"…","commentId":id,"runs":k,"evidenceDigest":"…","state":"closed","discardedStdin":bool}. Exits 3 (stdin held nothing), 4 (the manifest or the log does not parse), 5/6 (leak), 7 (the spike is absent, or closed with nothing to supersede), 8/9 (the post or the close was unproven, the read-back differs), 10 (off-grammar --nonce), 11 (a precondition read failed — nothing was posted), 12 (no workspace), 14 (zero recorded runs — a decision here would be a self-report), 18 (the manifest names another spike), 19 (the author holds below write). Example: fabrika spike capture 9310 --nonce 7f3a9c21 < decision.md',
	),
);

const dispose = leafCommand(
	"dispose",
	{
		nonce: nonceFlag,
		forfeit: Flag.boolean("forfeit").pipe(
			Flag.withDescription(
				"abandon the spike without a decision: post a forfeit note naming the run count, close, then dispose; never bypasses the tree check",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({nonce, forfeit, repo}) {
		yield* emit(
			yield* runDispose({
				nonce,
				forfeit,
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Remove the workspace and prove the tree is unchanged."),
	Command.withDescription(
		'Prove the repository tree is unchanged and the capture still covers the log, remove the workspace, and prove it is gone. Prints {"spike":n,"nonce":"…","workspace":"removed","treeMatched":true,"runs":k,"forfeited":bool}. Exits 4 (the manifest or the log does not parse), 5/6 (leak in the forfeit note), 7 (the spike is proven absent), 8/9 (the note post or the close was unproven, the read-back differs), 10 (off-grammar --nonce), 11 (a read failed — nothing was removed), 12 (no workspace), 15 (no captured decision and no --forfeit), 16 (removed and still present on re-probe), 17 (the tree moved since open — NOTHING was removed), 21 (the log moved after the capture). Example: fabrika spike dispose --nonce 7f3a9c21',
	),
);

const status = leafCommand(
	"status",
	{nonce: nonceFlag, repo: repoFlag},
	Effect.fn(function* ({nonce, repo}) {
		yield* emit(
			yield* runStatus({
				nonce,
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("One run's spike state, workspace and evidence count."),
	Command.withDescription(
		'One run\'s spike state, workspace presence and evidence count — near-total, because its consumer is a session resuming cold. An absent workspace is a FACT at exit 0. Prints {"nonce":"…","workspace":"present|absent","spike":n,"kind":"…","question":"…","spikeState":"open|closed|null","captured":bool,"runs":k,"lastCommandExit":n,"evidenceDigest":"…","treeMatched":bool}. Exits 4 (the manifest or the log exists and does not parse), 10 (off-grammar --nonce), 11 (the spike state, its comments or the tree state could not be read). Example: fabrika spike status --nonce 7f3a9c21',
	),
);

export const spikeCommand = Command.make("spike").pipe(
	Command.withSubcommands([open, run, capture, dispose, status]),
	Command.withShortDescription("Settle one empirical question by building a throwaway."),
	Command.withDescription(
		"Settle one empirical question by building a throwaway: mint the spike and its workspace outside the repository, record every run as evidence, capture the decision on the issue, and prove the throwaway was thrown away",
	),
);
