/**
 * `read-guard` PreToolUse hook — the live wiring of the pure core (issue #740).
 *
 * Reads the Claude Code PreToolUse hook envelope from stdin (`tool_name`,
 * `tool_input.file_path`, `transcript_path`), reconstructs the session read-set
 * from the transcript, stats the target, asks the pure `decide` core, and emits
 * the hook decision:
 *
 *   - `no-op`      → `permissionDecision: allow` (the edit proceeds, no extra Read).
 *   - `inject-read`→ `permissionDecision: deny` with a `Read <abs-path> first` reason.
 *
 * Block, not inject — by design. The documented PreToolUse surface
 * (plugin-dev hook-development; docs.claude.com/en/docs/claude-code/hooks) can
 * `allow`/`deny`/`ask` and rewrite `updatedInput`, but has **no** documented way to
 * *inject* a separate `Read` tool call ahead of the edit. So we take the
 * deterministic block-with-exact-instruction form the issue calls for: a precise
 * `deny` the agent resolves in one turn (Read the named path, retry the edit),
 * replacing the harness's raw `File has not been read yet` refusal with an
 * actionable one. This is the read-guard analog of leak-guard's PreToolUse wiring.
 *
 * Fail-open: any malformed envelope, unreadable transcript, or unexpected error
 * exits 0 with `allow` (and an empty body) — a hook crash must never wedge an edit.
 * It is a turn-saver, not a gate; when it can't decide, it gets out of the way.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/leak-guard`):
 * `@effect/platform-node` for stdin + filesystem, run via `NodeRuntime.runMain`.
 */
import {readFileSync, statSync} from "node:fs";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";
import {blockReason, decide} from "./read-guard.ts";
import {parseReadSet} from "./transcript.ts";

interface HookEnvelope {
	readonly tool_name?: unknown;
	readonly tool_input?: {readonly file_path?: unknown} | null;
	readonly transcript_path?: unknown;
}

/** `permissionDecision: allow` — get out of the way (also the fail-open output). */
const ALLOW = JSON.stringify({hookSpecificOutput: {permissionDecision: "allow"}});

const denyOutput = (reason: string): string =>
	JSON.stringify({
		hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny"},
		systemMessage: reason,
	});

const readStdin = (): string => {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
};

/** Current mtime of `path` in epoch-ms, or `null` if it does not exist / can't be statted. */
const currentMtimeMs = (path: string): number | null => {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
};

const readTranscript = (path: string): string => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};

/** The decision for one PreToolUse envelope — pure-ish glue around the core; total. */
export const decideForEnvelope = (
	raw: string,
): {readonly allow: boolean; readonly reason?: string} => {
	let env: HookEnvelope;
	try {
		env = JSON.parse(raw) as HookEnvelope;
	} catch {
		return {allow: true};
	}
	if (env.tool_name !== "Edit" && env.tool_name !== "Write") return {allow: true};
	const target = env.tool_input?.file_path;
	if (typeof target !== "string" || target.length === 0) return {allow: true};
	const transcriptPath = typeof env.transcript_path === "string" ? env.transcript_path : "";
	const readSet = transcriptPath ? parseReadSet(readTranscript(transcriptPath)) : [];
	// #740/#776: when ZERO reads are reconstructable the read-set is UNRELIABLE — a
	// worktree/child-session transcript uses a shape parseReadSet can't see, so every
	// file reads as "never-read" and every Edit is wrongly DENIED (fail-closed). Defer
	// to the harness's own native read-before-edit check here: read-guard only adds its
	// precise-instruction deny when it can RELIABLY see reads (a non-empty read-set).
	if (readSet.length === 0) return {allow: true};
	const decision = decide(target, readSet, currentMtimeMs(target));
	if (decision.kind === "no-op") return {allow: true};
	return {allow: false, reason: blockReason(decision.path, decision.reason)};
};

const main = Effect.gen(function* () {
	// Any failure inside → fail-open ALLOW (catchAll below); a hook crash never wedges an edit.
	const decision = yield* Effect.sync(() => decideForEnvelope(readStdin()));
	yield* Console.log(decision.allow ? ALLOW : denyOutput(decision.reason ?? ""));
});

main.pipe(
	Effect.catch(() => Console.log(ALLOW)),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
