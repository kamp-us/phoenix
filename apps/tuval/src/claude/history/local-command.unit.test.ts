/**
 * A slash command's own frames are the session's word, not the operator's (#8211, #8641).
 *
 * The CLI runs a command like `/model` locally and records both its caveat and its result as
 * user-role messages whose whole text is one wrapper. Read as turns they land under YOU, wrapper
 * and terminal escapes included — the shape the founder's desk screenshot caught. The output
 * becomes a notice, the caveat becomes nothing. All three fixtures here are that record, taken
 * from an operator's own CLI session log under the founder's ruling on
 * [#8151](https://github.com/kamp-us/phoenix/issues/8151#issuecomment-5556626806) and re-keyed to
 * `SessionMessage` (`fixtures/PROVENANCE.md`).
 */

import type {SDKMessage, SessionMessage} from "@anthropic-ai/claude-agent-sdk";
import {describe, expect, it} from "vitest";
import type {TranscriptItem} from "../../ai-agent/ports/index.ts";
import {toAgentEvents} from "./events.ts";
import {loadFixture} from "./fixtures/load.ts";
import {toHistoryItems} from "./items.ts";
import {emptyMapping} from "./map.ts";

const AT = 1_700_000_000_000;

const frame = (name: Parameters<typeof loadFixture>[0]) => loadFixture(name) as SDKMessage;

const mapped = (message: SDKMessage): ReadonlyArray<TranscriptItem> =>
	toAgentEvents(message, emptyMapping, {at: AT}).events.flatMap((event) =>
		event.kind === "item" ? [event.item] : [],
	);

const skippedBy = (message: SDKMessage): number =>
	toAgentEvents(message, emptyMapping, {at: AT}).mapping.skipped;

/** The captured frame with one field replaced, so the envelope under test stays the capture's. */
const withText = (message: SDKMessage, text: string): SDKMessage =>
	({...message, message: {role: "user", content: text}}) as SDKMessage;

describe("a captured local command's output", () => {
	const captured = frame("local-command-turn");

	it("lands as a session notice, keeping the frame's identity, clock and top-level attribution", () => {
		expect(mapped(captured)).toEqual([
			{
				kind: "system",
				id: "00000000-0000-4000-8000-000000000060",
				timestamp: Date.parse("2026-07-24T06:56:27.863Z"),
				text: "Set model to Fable 5 and saved as your default for new sessions",
			},
		]);
	});

	it("shows the result as readable text: no wrapper, no colour escapes", () => {
		const [one] = mapped(captured);
		expect(one?.kind).toBe("system");
		const line = one?.kind === "system" ? one.text : "";
		expect(line).not.toMatch(/local-command-stdout/);
		expect(line).not.toMatch(new RegExp(String.fromCharCode(27)));
	});

	it("replays the same way off a stored session, so an old session reads back as it ran", () => {
		const {items, skipped} = toHistoryItems([captured as SessionMessage], {at: AT});
		expect(items.map((one) => one.kind)).toEqual(["system"]);
		expect(skipped).toBe(0);
	});

	it("keeps the whole output behind the notice's detail when the line is not all of it", () => {
		const whole =
			"Shift+Enter is natively supported in Kitty.\n\nNo configuration needed. Just use Shift+Enter to add newlines.";
		expect(mapped(frame("local-command-lines-turn"))).toEqual([
			{
				kind: "system",
				id: "00000000-0000-4000-8000-000000000062",
				timestamp: Date.parse("2026-06-10T05:50:46.734Z"),
				text: "Shift+Enter is natively supported in Kitty.",
				detail: whole,
			},
		]);
	});
});

describe("an operator's own turn on the same envelope", () => {
	const captured = frame("local-command-turn");

	it("stays a user item when the prompt merely talks about the wrapper", () => {
		const prompt = "why does <local-command-stdout>x</local-command-stdout> show up as my message?";
		expect(mapped(withText(captured, prompt))).toEqual([
			{
				kind: "user",
				id: "00000000-0000-4000-8000-000000000060",
				timestamp: Date.parse("2026-07-24T06:56:27.863Z"),
				text: prompt,
			},
		]);
	});

	it("stays a user item when the prompt quotes the wrapper as a code example", () => {
		const prompt =
			"```\n<local-command-stdout>Set model to X</local-command-stdout>\n```\nfix this";
		const [one] = mapped(withText(captured, prompt));
		expect(one?.kind).toBe("user");
		expect(one?.kind === "user" ? one.text : "").toBe(prompt);
	});
});

describe("a captured local command's caveat", () => {
	const captured = frame("local-command-caveat-turn");

	it("reaches the transcript as nothing at all, and is counted skipped", () => {
		expect(mapped(captured)).toEqual([]);
		expect(skippedBy(captured)).toBe(1);
	});

	it("replays the same way off a stored session", () => {
		const {items, skipped} = toHistoryItems([captured as SessionMessage], {at: AT});
		expect(items).toEqual([]);
		expect(skipped).toBe(1);
	});

	it("leaves the command's own output alone: that frame is still a notice", () => {
		const [one] = mapped(frame("local-command-turn"));
		expect(one?.kind).toBe("system");
	});

	it("stays a user item when the prompt merely quotes the caveat wrapper", () => {
		const prompt =
			"why does <local-command-caveat>Caveat: ...</local-command-caveat> show up as my message?";
		const [one] = mapped(withText(captured, prompt));
		expect(one?.kind).toBe("user");
		expect(one?.kind === "user" ? one.text : "").toBe(prompt);
	});
});
