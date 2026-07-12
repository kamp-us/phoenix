/**
 * The `worktree-guard` tool — `pipeline-cli worktree-guard <pre-file|pre-bash|pre-enter|reap>`.
 *
 * The worktree-pinning hook surface for an `isolation:worktree` subagent (issue
 * #741), moved into the pipeline-cli registry (epic #994, Phase 2 / #998). The four
 * hook subcommands each read the hook's stdin JSON envelope, run a pure core, and
 * emit the matching hook output; a fifth (`assert-clean`, #2666) is an operator/skill
 * invocation — not a hook — that fails closed on a dirty worktree. All read `$WORKTREE_ROOT` from the process
 * env (injected at spawn for an `isolation:worktree` subagent); an UNSET root makes
 * every subcommand a clean allow/skip no-op, so a non-worktree session is never
 * affected — with ONE exception (ADR 0172): `pre-bash` still refuses a head-moving git
 * op when isolation was EXPECTED (a direct coder/reviewer/shipper agent-type, or a nested
 * crew spawn detected via `git-dir == git-common-dir`; #2462) yet the root is unset, because
 * that unset root is itself the #2440 harness no-op that would otherwise let the #2452/#2453
 * primary-checkout detach through.
 *
 *   PreToolUse:
 *     pre-file  (matcher Read|Edit|Write) — rewrite/block a main-checkout path
 *     pre-bash  (matcher Bash)            — pin cwd to $WORKTREE_ROOT
 *     pre-enter (matcher EnterWorktree)   — hard-block a nested worktree
 *   SubagentStop:
 *     reap                                — `git worktree remove` (no --force) when clean
 *   Skill/operator invocation (not a hook):
 *     assert-clean [--path <d>]           — fail closed LOUD if the tree is dirty (#2666)
 *
 * The handlers are byte-identical to the former package's `bin.run.ts`. Its thin
 * `bin.ts` #777 stale-tree shim (a dynamic import gated on a dep-resolution probe)
 * is dropped: the `pipeline-cli` bin imports `@effect/platform-node` statically, so
 * by the time a subcommand runs the runtime dep is always resolved.
 */
import {execFileSync} from "node:child_process";
import {existsSync, statSync} from "node:fs";
import {resolve} from "node:path";
import {
	appendRecord,
	decideBashStagingAttribution,
	defaultLogPath,
	renderBashStagingNote,
} from "@kampus/primary-index-tripwire";
import {Console, Data, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {isIsolationExpected, pinBash} from "./bash-pin.ts";
import {decideCleanTree} from "./clean-tree.ts";
import {guardEnterWorktree} from "./enter-guard.ts";
import {mainCheckoutPrefix, resolvePath} from "./path-resolve.ts";
import {decideReap} from "./reap.ts";

const GATE_FAIL_EXIT_CODE = 1;

const WORKTREE_ROOT = process.env.WORKTREE_ROOT ?? "";

// Is this run sitting on the PRIMARY checkout? Env-independent signal (see ADR 0172 amendment,
// #2462): `git rev-parse --absolute-git-dir` equals the (cwd-resolved) `--git-common-dir` on the
// primary checkout, but differs in a linked worktree (whose per-tree git dir is
// `.git/worktrees/<id>`) — the same signal write-code Step-4 uses. This corroborates the isolation
// gate for a NESTED crew spawn whose inherited $CLAUDE_CODE_AGENT (engineering-manager) masks the
// direct agent-type regex. Resolved against the hook's reported cwd; unknowable ⇒ false (degrade to
// today's allow, never a spurious refusal).
const onPrimaryCheckout = (cwd: string): boolean => {
	const base = cwd || process.cwd();
	try {
		const opts = {cwd: base, encoding: "utf8" as const};
		const gitDir = resolve(
			base,
			execFileSync("git", ["rev-parse", "--absolute-git-dir"], opts).trim(),
		);
		const commonDir = resolve(
			base,
			execFileSync("git", ["rev-parse", "--git-common-dir"], opts).trim(),
		);
		return gitDir === commonDir;
	} catch {
		return false;
	}
};

/**
 * Run-time #2778 attribution (#2784, part 2): record — never block — a bulk-staging Bash command at
 * the `pre-bash` boundary, where the offending COMMAND string + cwd are still in hand (the
 * pre-commit tripwire sees only post-hoc index state). Best-effort and total: any failure is
 * swallowed so it can NEVER perturb the pin decision this hook actually emits. Writes through the
 * same out-of-repo log the read-only `primary-index-tripwire record` bin uses (no second surface).
 */
const recordBashStaging = (command: string, cwd: string): void => {
	try {
		const decision = decideBashStagingAttribution({
			command,
			cwd,
			onPrimaryCheckout: onPrimaryCheckout(cwd),
			agentType: process.env.CLAUDE_CODE_AGENT ?? "",
			sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? "",
			worktreeRoot: WORKTREE_ROOT,
			at: new Date().toISOString(),
		});
		if (decision.kind !== "record") return;
		appendRecord(defaultLogPath(), `${JSON.stringify(decision.record)}\n`);
		process.stderr.write(`${renderBashStagingNote(decision.record)}\n`);
	} catch {
		// Attribution is best-effort; a recording failure must never affect the pin decision.
	}
};

// A non-force `git worktree remove` that errors means git judged the tree unsafe to
// remove — we KEEP it (never escalate to --force). Tagged so the error channel stays typed.
class RemoveRefused extends Data.TaggedError("RemoveRefused")<{readonly path: string}> {}

const readStdin = (): Effect.Effect<unknown> =>
	Effect.promise(async () => {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks).toString("utf8").trim();
		if (raw === "") return {};
		try {
			return JSON.parse(raw) as unknown;
		} catch {
			return {};
		}
	});

const field = (obj: unknown, ...path: string[]): unknown => {
	let cur: unknown = obj;
	for (const key of path) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const allow = (updatedInput?: Record<string, unknown>, systemMessage?: string) =>
	Console.log(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				...(updatedInput ? {updatedInput} : {}),
			},
			...(systemMessage ? {systemMessage} : {}),
		}),
	);

const deny = (reason: string) =>
	Console.log(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
			systemMessage: reason,
		}),
	);

const preFile = Command.make(
	"pre-file",
	{},
	Effect.fn(function* () {
		const input = yield* readStdin();
		const toolInput = (field(input, "tool_input") as Record<string, unknown>) ?? {};
		const candidate = str(toolInput.file_path);
		const cwd = str(field(input, "cwd"));
		const decision = resolvePath({
			worktreeRoot: WORKTREE_ROOT,
			cwd,
			candidatePath: candidate,
			existsInWorktree: (p) => {
				try {
					return existsSync(p);
				} catch {
					return false;
				}
			},
		});
		switch (decision.kind) {
			case "allow":
				return yield* allow();
			case "rewrite":
				return yield* allow(
					{...toolInput, file_path: decision.absolutePath},
					`worktree-guard: rewrote file_path → ${decision.absolutePath} (${decision.reason})`,
				);
			case "block":
				return yield* deny(`worktree-guard: ${decision.reason}. Use: ${decision.corrected}`);
		}
	}),
).pipe(Command.withDescription("PreToolUse Read|Edit|Write: pin/rewrite paths to $WORKTREE_ROOT"));

const preBash = Command.make(
	"pre-bash",
	{},
	Effect.fn(function* () {
		const input = yield* readStdin();
		const toolInput = (field(input, "tool_input") as Record<string, unknown>) ?? {};
		const command = str(toolInput.command);
		const cwd = str(field(input, "cwd"));
		// Run-time #2778 attribution (#2784): record a bulk-staging op before deciding the pin. Purely
		// additive and best-effort — it never changes the pin decision emitted below.
		recordBashStaging(command, cwd);
		const decision = pinBash({
			worktreeRoot: WORKTREE_ROOT,
			command,
			isolationExpected: isIsolationExpected({
				agentType: process.env.CLAUDE_CODE_AGENT ?? "",
				onPrimaryCheckout: onPrimaryCheckout(cwd),
			}),
		});
		if (decision.kind === "allow") return yield* allow();
		if (decision.kind === "refuse") return yield* deny(`worktree-guard: ${decision.reason}`);
		return yield* allow(
			{...toolInput, command: decision.command},
			`worktree-guard: ${decision.reason}`,
		);
	}),
).pipe(
	Command.withDescription(
		"PreToolUse Bash: cd-pin to $WORKTREE_ROOT; refuse a bare working-state-mutating git op — checkout/switch/reset/rebase/stash/merge (#1571, #2030)",
	),
);

const preEnter = Command.make(
	"pre-enter",
	{},
	Effect.fn(function* () {
		yield* readStdin();
		const decision = guardEnterWorktree(WORKTREE_ROOT);
		if (decision.kind === "allow") return yield* allow();
		return yield* deny(`worktree-guard: ${decision.reason}`);
	}),
).pipe(
	Command.withDescription("PreToolUse EnterWorktree: hard-block when already inside a worktree"),
);

/** Is the worktree dirty? `git status --porcelain` non-empty ⇒ dirty (also dirty if we can't tell — fail-safe to KEEP). */
const worktreeIsDirty = (root: string): boolean => {
	try {
		const out = execFileSync("git", ["-C", root, "status", "--porcelain"], {
			encoding: "utf8",
		});
		return out.trim() !== "";
	} catch {
		// Can't determine status → treat as dirty so we never reap an indeterminate tree.
		return true;
	}
};

const reap = Command.make(
	"reap",
	{},
	Effect.fn(function* () {
		yield* readStdin();
		if (!WORKTREE_ROOT || !existsSync(WORKTREE_ROOT)) {
			return yield* Console.error("worktree-guard reap: no $WORKTREE_ROOT to reap (skip)");
		}
		let dir = true;
		try {
			dir = statSync(WORKTREE_ROOT).isDirectory();
		} catch {
			dir = false;
		}
		if (!dir) {
			return yield* Console.error("worktree-guard reap: $WORKTREE_ROOT is not a directory (skip)");
		}
		const decision = decideReap({
			worktreeRoot: WORKTREE_ROOT,
			isDirty: worktreeIsDirty(WORKTREE_ROOT),
		});
		switch (decision.kind) {
			case "skip":
			case "refuse":
				return yield* Console.error(`worktree-guard reap: ${decision.reason} (${WORKTREE_ROOT})`);
			case "reap": {
				// No --force, by contract: a dirty tree would error here and be KEPT. Run the
				// remove with `-C` at the MAIN checkout — it owns the worktree list, and the
				// hook's own cwd is unreliable (it may be the main checkout or anywhere).
				const mainRoot = mainCheckoutPrefix(WORKTREE_ROOT) ?? WORKTREE_ROOT;
				return yield* Effect.try({
					try: () => {
						execFileSync("git", ["-C", mainRoot, "worktree", "remove", WORKTREE_ROOT], {
							encoding: "utf8",
						});
					},
					catch: () => new RemoveRefused({path: WORKTREE_ROOT}),
				}).pipe(
					Effect.matchEffect({
						onSuccess: () =>
							Console.error(`worktree-guard reap: reaped clean worktree ${WORKTREE_ROOT}`),
						// A non-force remove that errors means git judged it unsafe — KEEP, never escalate to --force.
						onFailure: () =>
							Console.error(
								`worktree-guard reap: \`git worktree remove\` refused ${WORKTREE_ROOT} — KEPT (never --force)`,
							),
					}),
				);
			}
		}
	}),
).pipe(
	Command.withDescription(
		"SubagentStop: reap a CLEAN worktree (git worktree remove, never --force)",
	),
);

const pathFlag = Flag.string("path").pipe(
	Flag.optional,
	Flag.withDescription("the worktree to assert clean (default: $WORKTREE_ROOT)"),
);

// Read `git status --porcelain` at a path; null when git cannot run there (not a repo, missing
// dir) — the null is the fail-closed signal decideCleanTree maps to DIRTY, never a false clean.
const readPorcelain = (path: string): string | null => {
	try {
		return execFileSync("git", ["-C", path, "status", "--porcelain"], {encoding: "utf8"});
	} catch {
		return null;
	}
};

const assertClean = Command.make(
	"assert-clean",
	{path: pathFlag},
	Effect.fn(function* ({path: pathOpt}) {
		const target = Option.getOrElse(pathOpt, () => WORKTREE_ROOT);
		if (!target) {
			yield* Console.error(
				"worktree-guard assert-clean: no target — pass --path or set $WORKTREE_ROOT.",
			);
			return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
		}
		const decision = decideCleanTree({path: target, porcelain: readPorcelain(target)});
		if (decision.kind === "clean") {
			return yield* Console.error(`worktree-guard assert-clean: ${decision.reason}`);
		}
		yield* Console.error(
			`worktree-guard assert-clean FAILED (fail-closed, LOUD): ${decision.reason}`,
		);
		return yield* Effect.sync(() => process.exit(GATE_FAIL_EXIT_CODE));
	}),
).pipe(
	Command.withDescription(
		"Assert a worktree is clean (git status --porcelain); fail-closed LOUD on a dirty fresh tree (#2666)",
	),
);

export const worktreeGuardCommand = Command.make("worktree-guard").pipe(
	Command.withSubcommands([preFile, preBash, preEnter, reap, assertClean]),
	Command.withDescription("Worktree-pinning PreToolUse hooks + a SubagentStop reaper (issue #741)"),
);
