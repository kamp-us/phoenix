import {Result, Schema} from "effect";
import type {KeyGroup} from "../key-group.ts";

export const CODEX_USAGE = "codexUsage";
const CodexUsage = Schema.Literals(["on", "off"]);
export type CodexUsage = typeof CodexUsage.Type;
export const SHIPPED_CODEX_USAGE: CodexUsage = "on";
const decode = Schema.decodeUnknownResult(CodexUsage);

export const codexUsageKey: KeyGroup<CodexUsage> = {
	key: CODEX_USAGE,
	shippedDefault: SHIPPED_CODEX_USAGE,
	decode: (raw) => {
		const parsed = decode(raw);
		return Result.isSuccess(parsed)
			? {_tag: "Value", value: parsed.success}
			: {_tag: "Malformed", reason: `\`${CODEX_USAGE}\` is not one of "on", "off"`};
	},
	jsonSchema: {
		type: "string",
		enum: CodexUsage.literals,
		description:
			"Automatic Codex usage collection: on (the shipped default) or off (dispatch and native hooks skip transcript, association and ledger collection; accounting is unavailable). Read from the primary checkout's tracked policy, including uncommitted edits, rather than linked worktree copies. Manual spend commands, existing records, native logs and other providers are unchanged.",
	},
};
