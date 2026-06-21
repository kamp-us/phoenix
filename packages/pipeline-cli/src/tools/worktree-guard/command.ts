/**
 * The `worktree-guard` tool — `pipeline-cli worktree-guard <pre-file|pre-bash|pre-enter|reap>`.
 *
 * The worktree-pinning hook surface for an `isolation:worktree` subagent (issue
 * #741), moved into the pipeline-cli registry (epic #994, Phase 2 / #998). Four
 * subcommands, each reading the hook's stdin JSON envelope, running a pure core,
 * and emitting the matching hook output. All read `$WORKTREE_ROOT` from the process
 * env (injected at spawn for an `isolation:worktree` subagent); an UNSET root makes
 * every subcommand a clean allow/skip no-op, so a non-worktree session is never
 * affected.
 *
 *   PreToolUse:
 *     pre-file  (matcher Read|Edit|Write) — rewrite/block a main-checkout path
 *     pre-bash  (matcher Bash)            — pin cwd to $WORKTREE_ROOT
 *     pre-enter (matcher EnterWorktree)   — hard-block a nested worktree
 *   SubagentStop:
 *     reap                                — `git worktree remove` (no --force) when clean
 *
 * The handlers are byte-identical to the former package's `bin.run.ts`. Its thin
 * `bin.ts` #777 stale-tree shim (a dynamic import gated on a dep-resolution probe)
 * is dropped: the `pipeline-cli` bin imports `@effect/platform-node` statically, so
 * by the time a subcommand runs the runtime dep is always resolved.
 */
import {execFileSync} from "node:child_process";
import {existsSync, statSync} from "node:fs";
import {Console, Data, Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {pinBash} from "./bash-pin.ts";
import {guardEnterWorktree} from "./enter-guard.ts";
import {mainCheckoutPrefix, resolvePath} from "./path-resolve.ts";
import {decideReap} from "./reap.ts";

const WORKTREE_ROOT = process.env.WORKTREE_ROOT ?? "";

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
		const decision = pinBash({worktreeRoot: WORKTREE_ROOT, command});
		if (decision.kind === "allow") return yield* allow();
		return yield* allow(
			{...toolInput, command: decision.command},
			`worktree-guard: ${decision.reason}`,
		);
	}),
).pipe(
	Command.withDescription('PreToolUse Bash: prepend `cd "$WORKTREE_ROOT" &&` when no explicit cd'),
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

export const worktreeGuardCommand = Command.make("worktree-guard").pipe(
	Command.withSubcommands([preFile, preBash, preEnter, reap]),
	Command.withDescription("Worktree-pinning PreToolUse hooks + a SubagentStop reaper (issue #741)"),
);
