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
 * It also fails open structurally when it can't attribute the read-set to the edit:
 * an out-of-project target (#802) or a worktree-subagent target (#781) — see
 * `isUnattributable`. It is a turn-saver, not a gate; when it can't decide, it gets
 * out of the way.
 *
 * The runtime dep (`@effect/platform-node`) is loaded via a preflight-gated DYNAMIC
 * import (#777): a static top-level import would throw `ERR_MODULE_NOT_FOUND` at
 * module-load on a not-yet-installed tree, *before* any fail-open `catch` runs, and the
 * harness would silently fail-open — read-guard installed but enforcing nothing. The
 * preflight degrades to a LOUD fail-open ALLOW (stderr note) instead, so the gap is
 * visible. read-guard's documented posture is fail-OPEN (turn-saver, never wedge an
 * edit), so degraded-ALLOW is the right safe state here.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/leak-guard`):
 * `@effect/platform-node` for stdin + filesystem, run via `NodeRuntime.runMain`.
 */
import {readFileSync, statSync} from "node:fs";
import {resolve, sep} from "node:path";
import {depsInstalled, missingDepMessage} from "./preflight.ts";
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

/**
 * Can read-guard soundly attribute the handed transcript's read-set to an edit of
 * `target`? It can only when `target` lives in the SAME phoenix checkout whose reads
 * that transcript records. Two cases where it can't — both fail OPEN (defer to the
 * harness's own native read-before-edit check) rather than deny a read it can't see:
 *
 *   - **out-of-project** (#802): `target` is outside `$CLAUDE_PROJECT_DIR` — an
 *     ADR-0038 sibling-fork edit. read-guard reconstructs read-state from phoenix's
 *     transcript and has no authority over another repo's reads.
 *   - **worktree-subagent** (#781): `target` is inside a `.claude/worktrees/<agent>`
 *     subtree. The harness lands every agent worktree there (`git worktree add`); a
 *     worktree subagent's own `Read`s are recorded in a SEPARATE subagent transcript,
 *     not the one the hook is handed, so the reconstructed read-set is non-empty (it
 *     has the PARENT session's reads) yet omits this agent's reads of `target` → the
 *     edit reads as "never-read" and is wrongly DENIED. Unattributable, so fail open.
 *
 * When `$CLAUDE_PROJECT_DIR` is unset the out-of-project test can't run (can't bound
 * the project), so only the worktree subtree case applies — preserving the in-project
 * sound-deny (#755) for the common main-session path.
 */
const isUnattributable = (target: string): boolean => {
	const abs = resolve(target);
	const projectDir = process.env.CLAUDE_PROJECT_DIR;
	if (typeof projectDir === "string" && projectDir.length > 0) {
		const root = resolve(projectDir);
		// out-of-project: not `root` itself and not under `root/`.
		if (abs !== root && !abs.startsWith(root + sep)) return true;
	}
	// worktree-subagent: any `…/.claude/worktrees/…` segment (the harness's own
	// always-worktree landing dir) — reads live in a separate subagent transcript.
	return abs.includes(`${sep}.claude${sep}worktrees${sep}`);
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
	// #781/#802: fail OPEN when the read-set can't be attributed to this edit (out-of-
	// project fork edit, or a worktree-subagent whose reads are in a separate transcript)
	// — read-guard must not deny a read it structurally cannot see. See isUnattributable.
	if (isUnattributable(target)) return {allow: true};
	const transcriptPath = typeof env.transcript_path === "string" ? env.transcript_path : "";
	const readSet = transcriptPath ? parseReadSet(readTranscript(transcriptPath)) : [];
	// #740/#776: a fully-empty reconstructed read-set is likewise unreliable (a transcript
	// shape parseReadSet can't see) — defer to the harness rather than deny everything.
	if (readSet.length === 0) return {allow: true};
	const decision = decide(target, readSet, currentMtimeMs(target));
	if (decision.kind === "no-op") return {allow: true};
	return {allow: false, reason: blockReason(decision.path, decision.reason)};
};

/** The hook decision for the read stdin envelope, as the JSON line to print on stdout. */
export const renderDecision = (raw: string): string => {
	const decision = decideForEnvelope(raw);
	return decision.allow ? ALLOW : denyOutput(decision.reason ?? "");
};

// #777 preflight: resolve the runtime dep BEFORE the heavy dynamic import. Missing ⇒
// stale node_modules (pre-`pnpm install`) ⇒ degrade to a LOUD fail-open ALLOW so the
// hook is visibly not-enforcing, never a silent module-load crash that fail-opens unseen.
if (depsInstalled()) {
	const {run} = await import("./bin.run.ts");
	run(() => renderDecision(readStdin()), ALLOW);
} else {
	console.error(missingDepMessage("read-guard"));
	console.log(ALLOW);
}
