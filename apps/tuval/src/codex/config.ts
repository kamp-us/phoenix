import {Effect, Schema} from "effect";
import {Mode} from "../ai-agent/ports/index.ts";

export const CODEX_MODES = ["read-only", "workspace-write"] as const;
export const CodexSessionConfig = Schema.Struct({
	mode: Schema.Literals(CODEX_MODES).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("workspace-write" as const)),
	),
	model: Schema.optionalKey(Schema.String),
	streamPartialReplies: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});
export type CodexSessionConfigInput = typeof CodexSessionConfig.Encoded;
export type CodexSessionSettings = typeof CodexSessionConfig.Type;
export const codexSessionSettings = Schema.decodeUnknownSync(CodexSessionConfig);
export const codexModes = CODEX_MODES.map((mode) => Mode.make(mode));
