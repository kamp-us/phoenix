/**
 * The `worktree-guard` tool — `pipeline-cli worktree-guard <pre-file|pre-bash|pre-enter|reap>`.
 *
 * The worktree-pinning hook surface for an `isolation:worktree` subagent (issue
 * #741), moved into the pipeline-cli registry (epic #994, Phase 2 / #998). The four
 * hook subcommands each read the hook's stdin JSON envelope, run a pure core, and
 * emit the matching hook output; a fifth (`assert-clean`, #2666) is an operator/skill
 * invocation — not a hook — that fails closed on a dirty worktree. All read `$WORKTREE_ROOT` from
 * the process env; an UNSET root makes
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
 *     reap                                — `git worktree remove` (no --force) when clean AND the
 *                                           stopping agent OWNS $WORKTREE_ROOT (the #2798 owner gate)
 *   Skill/operator invocation (not a hook):
 *     assert-clean [--path <d>]           — fail closed LOUD if the tree is dirty (#2666)
 *
 * `$WORKTREE_ROOT` is NOT injected by the harness and is written by nothing in this repo, so for a
 * subagent it reads empty even inside a correctly-provisioned worktree — which is what disarms the
 * root-keyed branches above (ADR 0199, #3682). `isolation-identity.ts` resolves the root and the
 * agent-type from the harness's per-subagent sidecar instead; it is wired into the record-only
 * attribution path here, and deliberately NOT into any permission decision — re-keying what the
 * hooks REFUSE is gated on the open fail-open-vs-fail-closed ruling (#3743).
 *
 * The handlers are byte-identical to the former package's `bin.run.ts`. Its thin
 * `bin.ts` #777 stale-tree shim (a dynamic import gated on a dep-resolution probe)
 * is dropped: the `pipeline-cli` bin imports `@effect/platform-node` statically, so
 * by the time a subcommand runs the runtime dep is always resolved.
 *
 * The sync git/fs probe helpers below are best-effort by contract: a hook must never
 * crash on a git/fs hiccup, so every probe degrades to a SAFE fallback (allow / keep /
 * dirty), absorbing the failure into a returned value rather than the `E` channel. That
 * is why each carries a per-line `biome-ignore lint/plugin` — lifting them into
 * `Effect.try` only to re-collapse the error to the same fallback is noise, not the
 * failure-modeling `no-raw-try-catch` targets (the design-capture/upload.ts precedent).
 */
import {execFileSync} from "node:child_process";
import {existsSync, readFileSync, statSync} from "node:fs";
import {resolve} from "node:path";
import {
	appendRecord,
	decideBashStagingAttribution,
	defaultLogPath,
	renderBashStagingNote,
} from "@kampus/primary-index-tripwire";
import {Console, Effect, Option} from "effect";
import * as Schema from "effect/Schema";
import {Command, Flag} from "effect/unstable/cli";
import {isIsolationExpected, pinBash} from "./bash-pin.ts";
import {decideCleanTree} from "./clean-tree.ts";
import {guardEnterWorktree} from "./enter-guard.ts";
import {type AgentSidecar, resolveIsolationIdentity, sidecarPathFor} from "./isolation-identity.ts";
import {mainCheckoutPrefix, resolvePath} from "./path-resolve.ts";
import {decideReap} from "./reap.ts";

const GATE_FAIL_EXIT_CODE = 1;

const WORKTREE_ROOT = process.env.WORKTREE_ROOT ?? "";

/**
 * Which tree is this run sitting in? Env-independent signal (see ADR 0172 amendment, #2462):
 * `git rev-parse --absolute-git-dir` equals the (cwd-resolved) `--git-common-dir` on the primary
 * checkout, but differs in a linked worktree (whose per-tree git dir is `.git/worktrees/<id>`) —
 * the same signal write-code Step-4 uses. This corroborates the isolation gate for a NESTED crew
 * spawn whose inherited $CLAUDE_CODE_AGENT (engineering-manager) masks the direct agent-type regex.
 *
 * Tri-state on purpose: "unknown" (the probe could not run) is NOT "linked" and NOT "primary", so
 * neither consumer below can read a failed probe as positive evidence in its own direction.
 */
type TreeKind =
	| {readonly kind: "primary"}
	| {readonly kind: "linked"; readonly toplevel: string}
	| {readonly kind: "unknown"};

const probeTree = (cwd: string): TreeKind => {
	const base = cwd || process.cwd();
	// biome-ignore lint/plugin: best-effort probe — an unknowable git dir degrades to "unknown", never E (see file header).
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
		if (gitDir === commonDir) return {kind: "primary"};
		return {
			kind: "linked",
			toplevel: execFileSync("git", ["rev-parse", "--show-toplevel"], opts).trim(),
		};
	} catch {
		return {kind: "unknown"};
	}
};

// Unknowable ⇒ false (degrade to today's allow, never a spurious refusal).
const onPrimaryCheckout = (cwd: string): boolean => probeTree(cwd).kind === "primary";

/** The agent's OWN worktree + agent-type, from the harness sidecar named by the hook payload. */
const readSidecar = (input: unknown): AgentSidecar | null => {
	const path = sidecarPathFor({
		transcriptPath: str(field(input, "transcript_path")),
		agentId: str(field(input, "agent_id")),
	});
	if (path === null || !existsSync(path)) return null;
	// biome-ignore lint/plugin: best-effort read — an unreadable/malformed sidecar degrades to null (fall down the evidence chain), never E (see file header).
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return {
			worktreePath: str(field(parsed, "worktreePath")),
			agentType: str(field(parsed, "agentType")),
		};
	} catch {
		return null;
	}
};

/**
 * Run-time #2778 attribution (#2784, part 2): record — never block — a bulk-staging Bash command at
 * the `pre-bash` boundary, where the offending COMMAND string + cwd are still in hand (the
 * pre-commit tripwire sees only post-hoc index state). Best-effort and total: any failure is
 * swallowed so it can NEVER perturb the pin decision this hook actually emits. Writes through the
 * same out-of-repo log the read-only `primary-index-tripwire record` bin uses (no second surface).
 *
 * The recorded `agentType`/`worktreeRoot` come from {@link resolveIsolationIdentity}, not the raw
 * env: this log exists to attribute cross-lane contamination to a lane, and the env misnames the
 * lane in exactly the incidents it is meant to explain — an inherited `$CLAUDE_CODE_AGENT` and an
 * unset `$WORKTREE_ROOT` recorded every isolated coder as its parent, rootless (ADR 0199, #3682).
 * This is the record-only path on purpose; it emits no permission decision, so the resolved
 * identity cannot change what any hook allows or refuses.
 */
const recordBashStaging = (command: string, cwd: string, input: unknown): void => {
	// biome-ignore lint/plugin: best-effort attribution — any recording failure is swallowed so it can never perturb the pin decision, never E (see file header).
	try {
		const tree = probeTree(cwd);
		const identity = resolveIsolationIdentity({
			sidecar: readSidecar(input),
			payloadAgentType: str(field(input, "agent_type")),
			envWorktreeRoot: WORKTREE_ROOT,
			envAgentType: process.env.CLAUDE_CODE_AGENT ?? "",
			gitToplevel: tree.kind === "linked" ? tree.toplevel : "",
			isLinkedWorktree: tree.kind === "linked",
		});
		const decision = decideBashStagingAttribution({
			command,
			cwd,
			onPrimaryCheckout: tree.kind === "primary",
			agentType: identity.agentType,
			sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? "",
			worktreeRoot: identity.worktreeRoot,
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
class RemoveRefused extends Schema.TaggedErrorClass<RemoveRefused>()("RemoveRefused", {
	path: Schema.String,
}) {}

/** A stdin read that rejected — absorbed to the `{}` envelope so a hook never crashes on it. */
class StdinUnreadable extends Schema.TaggedErrorClass<StdinUnreadable>()("StdinUnreadable", {
	cause: Schema.Unknown,
}) {}

const readStdin = (): Effect.Effect<unknown> =>
	Effect.tryPromise({
		try: async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
			const raw = Buffer.concat(chunks).toString("utf8").trim();
			if (raw === "") return {};
			// biome-ignore lint/plugin: best-effort parse — a malformed stdin envelope degrades to {} (no fields), never E (see file header).
			try {
				return JSON.parse(raw) as unknown;
			} catch {
				return {};
			}
		},
		catch: (cause) => new StdinUnreadable({cause}),
	}).pipe(Effect.orElseSucceed(() => ({})));

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
				// biome-ignore lint/plugin: best-effort probe — an unstattable path degrades to false (absent), never E (see file header).
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
		recordBashStaging(command, cwd, input);
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

/**
 * Derive the STOPPING agent's OWN worktree from the SubagentStop payload — the owner signal the
 * #2798 gate turns on. The harness writes a per-subagent sidecar next to each subagent transcript
 * (`…/subagents/agent-<id>.meta.json`) recording the worktree that agent OWNS (`worktreePath`), and
 * the payload's `transcript_path` points at that transcript. A nested descendant that merely
 * inherited `$WORKTREE_ROOT` carries its OWN (different, or absent) `worktreePath`, so this
 * distinguishes an owner-stop from a nested stop. Anything unreadable ⇒ "" ⇒ ownership unprovable ⇒
 * `decideReap` KEEPs (fail-closed: never reap a possibly-live parent tree).
 */
const ownedWorktreeFromPayload = (input: unknown): string => {
	const transcriptPath = str(field(input, "transcript_path"));
	if (!transcriptPath) return "";
	const metaPath = transcriptPath.replace(/\.jsonl$/, ".meta.json");
	if (metaPath === transcriptPath || !existsSync(metaPath)) return "";
	// biome-ignore lint/plugin: best-effort read — an unreadable/malformed sidecar degrades to "" (ownership unprovable ⇒ decideReap KEEPs), never E (see file header).
	try {
		return str(field(JSON.parse(readFileSync(metaPath, "utf8")) as unknown, "worktreePath"));
	} catch {
		return "";
	}
};

/** Is the worktree dirty? `git status --porcelain` non-empty ⇒ dirty (also dirty if we can't tell — fail-safe to KEEP). */
const worktreeIsDirty = (root: string): boolean => {
	// biome-ignore lint/plugin: best-effort probe — an indeterminate status degrades to dirty (never reap), never E (see file header).
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
		const input = yield* readStdin();
		if (!WORKTREE_ROOT || !existsSync(WORKTREE_ROOT)) {
			return yield* Console.error("worktree-guard reap: no $WORKTREE_ROOT to reap (skip)");
		}
		let dir = true;
		// biome-ignore lint/plugin: best-effort probe — an unstattable root degrades to not-a-directory (skip), never E (see file header).
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
			ownedWorktree: ownedWorktreeFromPayload(input),
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
	// biome-ignore lint/plugin: best-effort probe — a non-repo/missing dir degrades to null (decideCleanTree maps to DIRTY, fail-closed), never E (see file header).
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
