/**
 * `leak-guard` CLI — the PreToolUse hook backing issue #173.
 *
 * Wired on `Write|Edit|MultiEdit` in `.claude/settings.json`. Reads the Claude
 * Code PreToolUse JSON envelope from stdin (parsed with `Effect.try` + a `Schema`
 * decode, the `epic-ledger`/`crabbox-manifest` idiom), extracts (file_path, text)
 * for the supported tools, runs the pure `findLeaks` core, and on a real leak
 * emits a `hookSpecificOutput.permissionDecision: "deny"` JSON on stdout and exits
 * 0. A clean write, a non-doc target, an unsupported tool, a JSON syntax error, OR
 * a valid-JSON-but-wrong-SHAPE envelope is allowed silently (exit 0) — the guard
 * NEVER blocks on a parse/decode failure.
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
import * as Schema from "effect/Schema";
import {Command} from "effect/unstable/cli";
import {findLeaks, type Leak} from "./leak-guard.ts";

// The Claude Code PreToolUse envelope (only the fields the guard folds; Schema
// ignores unknown keys). All optional → a wrong-SHAPE-but-valid JSON still decodes
// to an empty envelope, which extractTarget reads as "unsupported tool → allow".
const ToolEnvelope = Schema.Struct({
	tool_name: Schema.optional(Schema.String),
	tool_input: Schema.optional(
		Schema.Struct({
			file_path: Schema.optional(Schema.String),
			content: Schema.optional(Schema.String),
			new_string: Schema.optional(Schema.String),
			edits: Schema.optional(
				Schema.Array(Schema.Struct({new_string: Schema.optional(Schema.String)})),
			),
		}),
	),
});
type ToolEnvelope = (typeof ToolEnvelope)["Type"];

const decodeEnvelope = Schema.decodeUnknownEffect(ToolEnvelope);

/** Read all of stdin as UTF-8; an empty string when nothing is piped. */
const readStdin = Effect.try({
	try: () => readFileSync(0, "utf8"),
	// No stdin attached (e.g. an interactive run) — treat as empty → allow.
	catch: () => "",
}).pipe(Effect.orElseSucceed(() => ""));

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

		// Never block on a bad envelope: a JSON syntax error OR a valid-JSON-but-
		// wrong-shape body both fall through to a silent allow (exit 0).
		const env = yield* Effect.try({
			try: () => JSON.parse(raw) as unknown,
			catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
		}).pipe(Effect.flatMap(decodeEnvelope), Effect.option);
		if (env._tag === "None") return;

		const target = extractTarget(env.value);
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
