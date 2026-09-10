/**
 * A slash command's own frames are the session's word, not the operator's (#8211, #8641, #8665).
 *
 * The CLI runs a command like `/model` locally and records its caveat, the invocation itself and
 * its result as user-role messages whose whole text is markup. Read as turns they land under YOU,
 * tags and terminal escapes included — the shape the founder's desk screenshot caught. The output
 * and the invocation each become their own notice, the caveat becomes nothing. A plugin's or a
 * skill's invocation is the same record in a different hand — its tags come in another order, and a
 * skill's carries the whole skill body after them. Every fixture here is that record, taken
 * from an operator's own CLI session log under the founder's ruling on
 * [#8151](https://github.com/kamp-us/phoenix/issues/8151#issuecomment-5556626806) and re-keyed to
 * `SessionMessage` (`fixtures/PROVENANCE.md`).
 */

import type {SDKMessage, SessionMessage} from "@anthropic-ai/claude-agent-sdk";
import {describe, expect, it} from "vitest";
import {itemBytes} from "../../ai-agent/history/index.ts";
import {byteLength, type TranscriptItem} from "../../ai-agent/ports/index.ts";
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

describe("a captured local command's invocation record", () => {
	const captured = frame("local-command-invocation-turn");

	it("lands as its own session notice naming the command and its arguments", () => {
		expect(mapped(captured)).toEqual([
			{
				kind: "system",
				id: "00000000-0000-4000-8000-000000000079",
				timestamp: Date.parse("2026-07-25T23:22:33.911Z"),
				text: "/effort medium",
			},
		]);
	});

	it("shows the invocation as readable text: no tags, no colour escapes", () => {
		const [one] = mapped(captured);
		const line = one?.kind === "system" ? one.text : "";
		expect(line).not.toMatch(/[<>]/);
		expect(line).not.toMatch(new RegExp(String.fromCharCode(27)));
	});

	it("replays the same way off a stored session, so an old session reads back as it ran", () => {
		const {items, skipped} = toHistoryItems([captured as SessionMessage], {at: AT});
		expect(items).toEqual([
			{
				kind: "system",
				id: "00000000-0000-4000-8000-000000000079",
				timestamp: Date.parse("2026-07-25T23:22:33.911Z"),
				text: "/effort medium",
			},
		]);
		expect(skipped).toBe(0);
	});

	it("names the command alone when the invocation carries no arguments", () => {
		const [one] = mapped(withText(captured, "<command-name>/clear</command-name>"));
		expect(one?.kind === "system" ? one.text : "").toBe("/clear");
	});

	it("leaves the command's own output its own separate notice", () => {
		const [one] = mapped(frame("local-command-turn"));
		expect(one?.kind).toBe("system");
		expect(one?.kind === "system" ? one.text : "").toBe(
			"Set model to Fable 5 and saved as your default for new sessions",
		);
	});

	it("puts the invocation above the output, over one of each frame kind", () => {
		const command = [
			frame("local-command-caveat-turn") as SessionMessage,
			captured as SessionMessage,
			frame("local-command-turn") as SessionMessage,
		];
		const {items, skipped} = toHistoryItems(command, {at: AT});
		expect(items.map((one) => one.kind)).toEqual(["system", "system"]);
		expect(items.map((one) => (one.kind === "system" ? one.text : ""))).toEqual([
			"/effort medium",
			"Set model to Fable 5 and saved as your default for new sessions",
		]);
		expect(skipped).toBe(1);
	});

	it("stays a user item when the prompt merely quotes the invocation markup", () => {
		const prompt = "why does <command-name>/effort</command-name> show up as my message?";
		expect(mapped(withText(captured, prompt))).toEqual([
			{
				kind: "user",
				id: "00000000-0000-4000-8000-000000000079",
				timestamp: Date.parse("2026-07-25T23:22:33.911Z"),
				text: prompt,
			},
		]);
	});

	it("stays a user item when the prompt opens with the tag and then says more", () => {
		const prompt = "<command-name>/effort</command-name> is what I ran — why the raw markup?";
		const [one] = mapped(withText(captured, prompt));
		expect(one?.kind).toBe("user");
		expect(one?.kind === "user" ? one.text : "").toBe(prompt);
	});
});

describe("a captured skill invocation", () => {
	const captured = frame("local-command-skill-turn");
	const body =
		"Base directory for this skill: /tmp/tuval-capture/claude-plugins/fabrika/skills/triage\n\n# triage\n\nYou are the guardrail. **The failure that matters is not a missing label — it is a confident wrong\none**, indistinguishable from a correct one once it lands. Each step makes its answer checkable, not";

	it("lands as a notice naming the skill, with its body behind the disclosure", () => {
		expect(mapped(captured)).toEqual([
			{
				kind: "system",
				id: "00000000-0000-4000-8000-000000000081",
				timestamp: Date.parse("2026-08-18T01:48:12.086Z"),
				text: "fabrika:triage",
				detail: body,
			},
		]);
	});

	it("replays the same way off a stored session", () => {
		const {items, skipped} = toHistoryItems([captured as SessionMessage], {at: AT});
		expect(items.map((one) => (one.kind === "system" ? one.text : one.kind))).toEqual([
			"fabrika:triage",
		]);
		expect(skipped).toBe(0);
	});

	// Verbatim from a `/unslop` row in an operator's own session log: a plugin command writes the
	// two tags in this order and adds neither `<command-args>` nor `<skill-format>`.
	it("reads a plugin command that writes its message tag ahead of its name", () => {
		const plugin =
			"<command-message>unslop</command-message>\n<command-name>/unslop</command-name>";
		const [one] = mapped(withText(captured, plugin));
		expect(one?.kind).toBe("system");
		expect(one?.kind === "system" ? one.text : "").toBe("/unslop");
		expect(one?.kind === "system" ? one.detail : "none").toBeUndefined();
	});

	it("stays a user item when a prompt writes tags and then prose without the skill marker", () => {
		const prompt =
			"<command-message>unslop</command-message>\n<command-name>/unslop</command-name>\nwhy is this my message?";
		const [one] = mapped(withText(captured, prompt));
		expect(one?.kind).toBe("user");
		expect(one?.kind === "user" ? one.text : "").toBe(prompt);
	});

	it("stays a user item when a tag repeats, which no invocation record does", () => {
		const prompt =
			"<command-name>/a</command-name>\n<command-name>/b</command-name>\n<command-args>x</command-args>";
		const [one] = mapped(withText(captured, prompt));
		expect(one?.kind).toBe("user");
	});
});

describe("a notice body larger than the mapping's own ceiling", () => {
	const captured = frame("local-command-skill-turn");

	/** `map.ts`'s `NOTICE_DETAIL_BYTE_LIMIT`, which the module keeps to itself. */
	const DETAIL_LIMIT = 8_000;

	// The committed skill fixture is trimmed to six lines, so the size this bound exists for is
	// built here: the tags a real skill frame carries, then a body past the ceiling.
	const skillFrame = (body: string): string =>
		[
			"<command-message>fabrika:triage</command-message>",
			"<command-name>fabrika:triage</command-name>",
			"<skill-format>true</skill-format>",
			body,
		].join("\n");

	const detailOf = (text: string): string => {
		const [one] = mapped(withText(captured, text));
		return one?.kind === "system" ? (one.detail ?? "") : "";
	};

	it("cuts a skill's body to the ceiling and says in the panel that it did", () => {
		const detail = detailOf(skillFrame("word ".repeat(4_000)));
		expect(byteLength(detail)).toBeLessThanOrEqual(DETAIL_LIMIT);
		expect(detail).toMatch(/cut to fit the transcript window/);
	});

	it("holds the whole item inside that ceiling, which is what the window counts", () => {
		const [one] = mapped(withText(captured, skillFrame("word ".repeat(40_000))));
		expect(one).toBeDefined();
		if (one === undefined) return;
		expect(itemBytes(one)).toBeLessThan(DETAIL_LIMIT + 1_000);
	});

	it("cuts on a code-point boundary, so the panel reads no replacement character", () => {
		const detail = detailOf(skillFrame("é".repeat(6_000)));
		expect(byteLength(detail)).toBeLessThanOrEqual(DETAIL_LIMIT);
		expect(detail).not.toMatch(/�/);
	});

	it("leaves a body inside the ceiling whole, with no marker on it", () => {
		const body = "the skill's whole text";
		expect(detailOf(skillFrame(body))).toBe(body);
	});

	it("bounds a command output's own detail on the same ceiling", () => {
		const output = `first line\n${"word ".repeat(4_000)}`;
		const detail = detailOf(`<local-command-stdout>${output}</local-command-stdout>`);
		expect(byteLength(detail)).toBeLessThanOrEqual(DETAIL_LIMIT);
		expect(detail).toMatch(/cut to fit the transcript window/);
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
