/**
 * What a user writes for a `claude-session` row, as one Schema with its defaults and its refusals.
 *
 * Three fields are the user's and one is not. `modes` is fixed to the four the row advertises:
 * `bypassPermissions` and `dontAsk` each hand the model a decision the operator is here to make,
 * and the whole permission surface of this program is the card, so a row that could name them
 * would be a row that could turn the cards off (founder ruling on #7579, `agent/options.ts`).
 *
 * `allowedTools` refuses a bare built-in name rather than dropping it. An auto-allowed tool skips
 * `canUseTool` entirely, so a bare name here is a tool the model runs with no card and no rule —
 * the exact hole the default list of three `mcp__tuval__` wire names is scoped to avoid.
 *
 * The prefix is written out rather than imported from `./tools/server.ts`: that module builds the
 * in-process MCP server and reaches `@anthropic-ai/claude-agent-sdk`, and this one is read by the
 * row, which names no SDK type. `config.unit.test.ts` pins the two against each other.
 */

import {Effect, Schema} from "effect";
import {type Mode, Mode as ModeBrand} from "../ai-agent/ports/index.ts";

/** The MCP server the three kernel tools are served under; `tools/server.ts` owns the other half. */
export const TUVAL_WIRE_PREFIX = "mcp__tuval__";

/** The modes a `claude-session` row advertises. Fixed: a config cannot widen or narrow it. */
export const CLAUDE_MODES = ["default", "acceptEdits", "plan", "auto"] as const;

export type ClaudePermissionMode = (typeof CLAUDE_MODES)[number];

/** Auto-allowed without a card: this program's own three kernel tools, and nothing else. */
export const DEFAULT_ALLOWED_TOOLS: ReadonlyArray<string> = [
	`${TUVAL_WIRE_PREFIX}spawn`,
	`${TUVAL_WIRE_PREFIX}send`,
	`${TUVAL_WIRE_PREFIX}read`,
];

const TuvalWireName = Schema.String.check(
	Schema.makeFilter((value: string) => value.startsWith(TUVAL_WIRE_PREFIX), {
		message: `Expected an ${TUVAL_WIRE_PREFIX} wire name; a bare tool name is auto-allowed with no permission card`,
	}),
);

export const ClaudeSessionConfig = Schema.Struct({
	permissionMode: Schema.Literals(CLAUDE_MODES).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed("default" as const)),
	),
	allowedTools: Schema.Array(TuvalWireName).pipe(
		Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_ALLOWED_TOOLS)),
	),
	model: Schema.optionalKey(Schema.String),
});

/** What a config module writes: every key optional but `model`, which is optional too. */
export type ClaudeSessionConfigInput = typeof ClaudeSessionConfig.Encoded;

/** The decoded config the row runs on: the user's three fields plus the fixed mode list. */
export interface ClaudeSessionSettings {
	readonly permissionMode: Mode;
	readonly modes: ReadonlyArray<Mode>;
	readonly allowedTools: ReadonlyArray<string>;
	readonly model?: string;
}

const decode = Schema.decodeUnknownSync(ClaudeSessionConfig);

/**
 * Decode at the call, not at boot: `claudeSession({...})` is a typed call inside a config module
 * (#7509), and the loader already turns a module that throws into a named refusal naming that
 * module — so a bad row refuses the whole config rather than booting a session with a tool nobody
 * meant to auto-allow.
 */
export const claudeSessionSettings = (
	input: ClaudeSessionConfigInput = {},
): ClaudeSessionSettings => {
	const decoded = decode(input);
	return {
		permissionMode: ModeBrand.make(decoded.permissionMode),
		modes: CLAUDE_MODES.map((mode) => ModeBrand.make(mode)),
		allowedTools: decoded.allowedTools,
		...(decoded.model === undefined ? {} : {model: decoded.model}),
	};
};
