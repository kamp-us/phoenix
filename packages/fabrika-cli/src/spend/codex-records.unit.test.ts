import {expect, it} from "vitest";
import {CodexSessionReader, isAccountingRow, readCodexSession} from "./codex-records.ts";

const text = [
	{type: "session_meta", payload: {id: "t", cli_version: "0.154.0", cwd: "/w"}},
	{type: "turn_context", payload: {turn_id: "turn-1", model: "m"}},
	{type: "response_item", payload: {content: "é".repeat(50)}},
	{type: "token_usage_record", payload: {thread_id: "t", response_id: "r"}},
]
	.map((row) => JSON.stringify(row))
	.join("\r\n")
	.concat('\n\n{"type":');

it("streams a transcript in any chunking to the whole-text session, keeping accounting rows only", () => {
	const whole = readCodexSession(text);
	for (const size of [1, 7, 64, text.length]) {
		const reader = new CodexSessionReader(isAccountingRow);
		for (let at = 0; at < text.length; at += size) reader.feed(text.slice(at, at + size));
		expect(reader.finish()).toEqual({
			...whole,
			rows: whole?.rows.filter(isAccountingRow),
		});
	}
	expect(whole).toMatchObject({thread: "t", cwd: "/w", malformed: true});
	expect(whole?.rows).toHaveLength(5);
});

it("refuses a transcript whose first record is not the session header", () => {
	const reader = new CodexSessionReader(isAccountingRow);
	reader.feed(text.split("\r\n").slice(1).join("\n"));
	expect(reader.finish()).toBeNull();
});
