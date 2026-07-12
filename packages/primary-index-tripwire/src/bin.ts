#!/usr/bin/env node
/**
 * `primary-index-tripwire record` — the read-only attribution leg for the #2778 corruption.
 *
 * Gathers git facts with READ-ONLY plumbing (`git-io.ts`), reads the agent-identity env, runs the
 * pure {@link decideTripwire} core, and — on a trip — appends a JSON attribution record to a log path
 * and prints a LOUD stderr warning. It NEVER blocks and NEVER mutates git or the working tree: the
 * exit code is always 0, so wiring it into a `pre-commit` hook (see `lefthook.yml`) records the actor
 * about to commit a mass control-plane deletion without ever preventing a legitimate commit.
 * Prevention/blocking is the §CP hardening fix, out of scope here
 * (`ops/incidents/2778-primary-index-mass-staged-deletion.md`).
 *
 * The log path is `$PRIMARY_INDEX_TRIPWIRE_LOG`, else `${TMPDIR:-/tmp}/primary-index-tripwire.jsonl`
 * — an OUT-OF-REPO path so recording never dirties the tree it observes. Wired per effect-smol's CLI
 * guidance (mirrors `@kampus/orphan-sweep`): `effect/unstable/cli` for typed flags over
 * `NodeServices.layer`, run via `NodeRuntime.runMain`; the read-only git/log IO lives in `git-io.ts`.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {appendRecord, defaultLogPath, detectPrimaryCheckout, stagedDeletions} from "./git-io.ts";
import {decideTripwire, parseNameStatus, renderWarning} from "./tripwire.ts";

const thresholdFlag = Flag.integer("threshold").pipe(
	Flag.withDefault(10),
	Flag.withDescription("min control-plane staged deletions to record an attribution trip"),
);

const logFlag = Flag.string("log").pipe(
	Flag.optional,
	Flag.withDescription(
		"attribution log path (default: $PRIMARY_INDEX_TRIPWIRE_LOG or a temp file)",
	),
);

const record = Command.make(
	"record",
	{threshold: thresholdFlag, log: logFlag},
	Effect.fn(function* ({threshold, log}) {
		const decision = decideTripwire({
			onPrimaryCheckout: detectPrimaryCheckout(),
			staged: parseNameStatus(stagedDeletions()),
			cwd: process.cwd(),
			agentType: process.env.CLAUDE_CODE_AGENT ?? "",
			sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? "",
			worktreeRoot: process.env.WORKTREE_ROOT ?? "",
			threshold,
			at: new Date().toISOString(),
		});
		if (decision.kind === "quiet") return;
		const logPath = Option.getOrElse(log, defaultLogPath);
		appendRecord(logPath, `${JSON.stringify(decision.record)}\n`);
		yield* Console.error(`${renderWarning(decision.record)} → recorded to ${logPath}`);
	}),
).pipe(
	Command.withDescription(
		"Read-only #2778 attribution: record (never block) a mass control-plane staged deletion at commit time",
	),
);

record.pipe(
	Command.run({version: "0.0.0"}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
