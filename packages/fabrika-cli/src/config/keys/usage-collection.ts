import {Result, Schema} from "effect";
import type {KeyGroup} from "../key-group.ts";

export const USAGE_COLLECTION = "usageCollection";
const UsageCollection = Schema.Literals(["on", "off"]);
export type UsageCollection = typeof UsageCollection.Type;
export const SHIPPED_USAGE_COLLECTION: UsageCollection = "on";
const decode = Schema.decodeUnknownResult(UsageCollection);

export const usageCollectionKey: KeyGroup<UsageCollection> = {
	key: USAGE_COLLECTION,
	shippedDefault: SHIPPED_USAGE_COLLECTION,
	decode: (raw) => {
		const parsed = decode(raw);
		return Result.isSuccess(parsed)
			? {_tag: "Value", value: parsed.success}
			: {_tag: "Malformed", reason: `\`${USAGE_COLLECTION}\` is not one of "on", "off"`};
	},
	jsonSchema: {
		type: "string",
		enum: UsageCollection.literals,
		description:
			"Automatic Fabrika usage collection for Claude and Codex: on (the shipped default) or off (dispatch and native lifecycle hooks skip transcript, inventory, association and ledger collection; accounting is unavailable). Read from the primary checkout's tracked policy, including uncommitted edits, rather than linked worktree copies. Manual recording, existing records, native logs and agent execution are unchanged. Pi observation remains unsupported.",
	},
};
