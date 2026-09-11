import {Effect, Result} from "effect";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse} from "../verb.ts";
import {INPUT_UNREADABLE} from "./codes.ts";
import {recordUsage} from "./usage-ledger.ts";
import {parseUsageRecord} from "./usage-record.ts";

export const runRecord = Effect.fn("spend.record")(function* (options: {
	readonly ledger: string;
	readonly stdin: Effect.Effect<StdinRead>;
}) {
	const input = yield* options.stdin;
	if (input._tag !== "Text") return refuse(INPUT_UNREADABLE, "spend record: input unreadable");
	const decoded = parseUsageRecord(input.text);
	if (Result.isFailure(decoded))
		return refuse(INPUT_UNREADABLE, `spend record: ${decoded.failure}; nothing recorded`);
	const result = yield* recordUsage(options.ledger, decoded.success);
	return result.status === "failed"
		? refuse(INPUT_UNREADABLE, result.notice)
		: answer(JSON.stringify(result));
});
