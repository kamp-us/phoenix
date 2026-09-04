import {describe, expect, it} from "vitest";
import {
	isModePayload,
	isPermissionPayload,
	isPromptPayload,
	isTranscriptPagePayload,
	isTranscriptPayload,
	Mode,
} from "./payloads.ts";
import {ItemId, type TranscriptItem} from "./transcript-item.ts";

const item: TranscriptItem = {
	kind: "user",
	id: ItemId.make("u1"),
	timestamp: 1_756_000_000_000,
	text: "hi",
};
const whole = {items: 0, bytes: 0, reason: "none"} as const;

describe("transcript payload", () => {
	it("admits a tail with its omission metadata", () => {
		expect(isTranscriptPayload({items: [item], omitted: whole})).toBe(true);
		expect(
			isTranscriptPayload({items: [], omitted: {items: 3, bytes: 900, reason: "byte-limit"}}),
		).toBe(true);
	});

	it("refuses a tail with no omission metadata, an unknown reason, or a bad item", () => {
		expect(isTranscriptPayload({items: [item]})).toBe(false);
		expect(isTranscriptPayload({items: [], omitted: {items: 0, bytes: 0, reason: "trimmed"}})).toBe(
			false,
		);
		expect(isTranscriptPayload({items: [{kind: "user"}], omitted: whole})).toBe(false);
	});
});

describe("transcript-page payload", () => {
	it("admits a request from the oldest held item and from the live tail", () => {
		expect(isTranscriptPagePayload({kind: "request", before: "u1", limit: 20})).toBe(true);
		expect(isTranscriptPagePayload({kind: "request", before: null, limit: 20})).toBe(true);
	});

	it("refuses a request with a non-positive or fractional limit", () => {
		expect(isTranscriptPagePayload({kind: "request", before: null, limit: 0})).toBe(false);
		expect(isTranscriptPagePayload({kind: "request", before: null, limit: 1.5})).toBe(false);
	});

	it("admits a page whose cursor names an older page or none", () => {
		expect(isTranscriptPagePayload({kind: "page", items: [item], omitted: whole, next: "u0"})).toBe(
			true,
		);
		expect(isTranscriptPagePayload({kind: "page", items: [], omitted: whole, next: null})).toBe(
			true,
		);
	});

	it("refuses a page with no cursor field and a payload of neither kind", () => {
		expect(isTranscriptPagePayload({kind: "page", items: [], omitted: whole})).toBe(false);
		expect(isTranscriptPagePayload({kind: "reply", items: []})).toBe(false);
	});
});

describe("prompt payload", () => {
	it("admits text with and without an idempotency key", () => {
		expect(isPromptPayload({text: "go"})).toBe(true);
		expect(isPromptPayload({text: "go", key: "turn-4"})).toBe(true);
	});

	it("refuses a payload with no text or a non-string key", () => {
		expect(isPromptPayload({key: "turn-4"})).toBe(false);
		expect(isPromptPayload({text: "go", key: 4})).toBe(false);
	});
});

describe("permission payload", () => {
	const request = {
		title: "Run a command",
		displayName: "Bash",
		description: "runs git status",
		input: {command: "git status"},
		offersAlways: true,
	};

	it("admits the pending set keyed by request id, empty included", () => {
		expect(isPermissionPayload({kind: "pending", requests: {"req-1": request}})).toBe(true);
		expect(isPermissionPayload({kind: "pending", requests: {}})).toBe(true);
	});

	it("refuses a pending card missing a field the window renders", () => {
		expect(
			isPermissionPayload({kind: "pending", requests: {"req-1": {...request, displayName: 4}}}),
		).toBe(false);
	});

	it("admits each of the three decisions, with and without a message", () => {
		const decisions = ["allow-once", "allow-always", "deny"] as const;
		expect(
			decisions.map((decision) => isPermissionPayload({kind: "decision", request: "r", decision})),
		).toEqual([true, true, true]);
		expect(
			isPermissionPayload({kind: "decision", request: "r", decision: "deny", message: "no"}),
		).toBe(true);
	});

	it("refuses an unknown decision and an answer naming no request", () => {
		expect(isPermissionPayload({kind: "decision", request: "r", decision: "maybe"})).toBe(false);
		expect(isPermissionPayload({kind: "decision", request: "", decision: "deny"})).toBe(false);
	});
});

describe("mode payload", () => {
	it("admits a program that offers modes and one that offers none", () => {
		expect(
			isModePayload({kind: "state", current: Mode.make("plan"), available: [Mode.make("plan")]}),
		).toBe(true);
		expect(isModePayload({kind: "state", current: null, available: []})).toBe(true);
	});

	it("admits a set and refuses an empty mode name", () => {
		expect(isModePayload({kind: "set", mode: "plan"})).toBe(true);
		expect(isModePayload({kind: "set", mode: ""})).toBe(false);
	});

	it("refuses a state whose available list is not a list of mode names", () => {
		expect(isModePayload({kind: "state", current: null, available: [7]})).toBe(false);
	});
});
