/**
 * `leak-guard` CLI — the PreToolUse hook backing issue #173.
 *
 * Wired on `Write|Edit|MultiEdit` in `.claude/settings.json`. Reads the Claude
 * Code PreToolUse JSON envelope from stdin, extracts (file_path, text) for the
 * supported tools, runs the pure `findLeaks` core, and on a real leak emits a
 * `hookSpecificOutput.permissionDecision: "deny"` JSON on stdout and exits 0. A
 * clean write, a non-doc target, an unsupported tool, OR a malformed envelope is
 * allowed silently (exit 0) — the guard NEVER blocks on a parse failure.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@phoenix/epic-ledger` and
 * `@phoenix/crabbox-manifest`): `effect/unstable/cli` for the command, the Node
 * platform over `NodeServices.layer`, run via `NodeRuntime.runMain`. The hook
 * envelope arrives on stdin, so the command takes no args; the work is in the
 * handler, which reads fd 0 and decides allow-vs-deny.
 */
import {readFileSync} from "node:fs";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {findLeaks, type Leak} from "./leak-guard.ts";

interface ToolEnvelope {
	readonly tool_name?: string;
	readonly tool_input?: {
		readonly file_path?: string;
		readonly content?: string;
		readonly new_string?: string;
		readonly edits?: ReadonlyArray<{readonly new_string?: string}>;
	};
}

/** Read all of stdin as UTF-8; an empty string when nothing is piped. */
const readStdin = Effect.sync<string>(() => {
	try {
		return readFileSync(0, "utf8");
	} catch {
		// No stdin attached (e.g. an interactive run) — treat as empty → allow.
		return "";
	}
});

/** (file_path, text-being-written) for the supported tools, else null → allow. */
const extractTarget = (env: ToolEnvelope): {filePath: string; text: string} | null => {
	const input = env.tool_input ?? {};
	const filePath = input.file_path ?? "";
	switch (env.tool_name) {
		case "Write":
			return {filePath, text: input.content ?? ""};
		case "Edit":
			return {filePath, text: input.new_string ?? ""};
		case "MultiEdit":
			return {
				filePath,
				text: (input.edits ?? []).map((e) => e.new_string ?? "").join("\n"),
			};
		default:
			return null;
	}
};

const denyBody = (leaks: ReadonlyArray<Leak>): string => {
	const lines = leaks.map((l) => `  - \`${l.matched}\` — ${l.reason}`).join("\n");
	return [
		"Leak-guard blocked this write (issue #173): a user-local path may not enter a shared artifact.",
		"",
		lines,
		"",
		"Use a repo-relative path instead (apps/web/..., .claude/skills/...). If this is genuinely a documented pattern, not a real path, the surface may need to be added to DOC_SELF_EXEMPT in packages/leak-guard/src/leak-guard.ts.",
	].join("\n");
};

const emitDeny = (leaks: ReadonlyArray<Leak>): Effect.Effect<void> =>
	Console.log(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: denyBody(leaks),
			},
		}),
	);

const guard = Command.make(
	"leak-guard",
	{},
	Effect.fn(function* () {
		const raw = yield* readStdin;

		let env: ToolEnvelope;
		try {
			env = JSON.parse(raw) as ToolEnvelope;
		} catch {
			return; // malformed envelope: never block on parse failure
		}

		const target = extractTarget(env);
		if (!target) return;

		const leaks = findLeaks(target.filePath, target.text);
		if (leaks.length === 0) return;

		yield* emitDeny(leaks);
	}),
).pipe(
	Command.withDescription("Block user-local paths from entering shared-artifact doc surfaces"),
);

guard.pipe(
	Command.run({version: "0.0.0"}),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
