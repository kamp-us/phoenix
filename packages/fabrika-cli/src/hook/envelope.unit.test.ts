import {describe, expect, it} from "vitest";
import {readGoldenFixture} from "../golden-fixture.ts";
import {classifyEnvelope} from "./envelope.ts";

describe("classifyEnvelope keeps the three failures apart", () => {
	it("reads a well-formed envelope and reports every key the harness sent", () => {
		const read = classifyEnvelope(
			JSON.stringify({
				hook_event_name: "SessionStart",
				session_id: "s",
				transcript_path: "t",
				cwd: "/c",
				source: "startup",
			}),
		);
		expect(read).toMatchObject({
			_tag: "Envelope",
			envelope: {event: "SessionStart", session: "s", cwd: "/c"},
		});

		const captured = classifyEnvelope(
			readGoldenFixture(import.meta.url, "__fixtures__/pre-tool-use.payload.golden.json"),
		);
		expect(captured._tag === "Envelope" && captured.envelope.event).toBe("PreToolUse");
		expect(captured._tag === "Envelope" && captured.envelope.fields).toHaveLength(10);
	});

	it.each([
		["whitespace only", "  \n "],
	])("reads %s as Empty, never as malformed", (_label, text) => {
		expect(classifyEnvelope(text)._tag).toBe("Empty");
	});

	it.each([
		["unparseable bytes", "not json at all"],
		["a JSON array", "[]"],
		["a JSON scalar", '"SessionStart"'],
		["an object whose event name is not a string", '{"hook_event_name":7}'],
	])("reads %s as Malformed", (_label, text) => {
		expect(classifyEnvelope(text)._tag).toBe("Malformed");
	});

	it("names which required fields were missing, so a refusal is actionable", () => {
		const read = classifyEnvelope('{"hook_event_name":"SessionStart","cwd":"/c"}');
		expect(read).toMatchObject({
			_tag: "Malformed",
			reason: "missing string fields session_id, transcript_path",
		});
	});

	it("truncates the evidence rather than echoing an unbounded payload", () => {
		const read = classifyEnvelope(`{"junk":"${"x".repeat(500)}"`);
		expect(read._tag === "Malformed" && read.evidence.endsWith("…")).toBe(true);
	});
});
