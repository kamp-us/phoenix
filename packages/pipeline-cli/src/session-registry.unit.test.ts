import {assert, describe, it} from "@effect/vitest";
import {parseSessionRegistryEntry, sessionRegistryDir} from "./session-registry.ts";

const SID_A = "85123b6c-d220-46c5-ac19-77ccedffb3d7";
const join = (...segments: Array<string>): string => segments.join("/");

describe("sessionRegistryDir", () => {
	it("defaults to <home>/.claude/sessions", () => {
		assert.strictEqual(
			sessionRegistryDir({configDir: undefined, home: "/home/dev", join}),
			"/home/dev/.claude/sessions",
		);
	});

	it("honours $CLAUDE_CONFIG_DIR, and treats a blank one as unset", () => {
		assert.strictEqual(
			sessionRegistryDir({configDir: "/cfg", home: "/home/dev", join}),
			"/cfg/sessions",
		);
		assert.strictEqual(
			sessionRegistryDir({configDir: "   ", home: "/home/dev", join}),
			"/home/dev/.claude/sessions",
		);
	});
});

describe("parseSessionRegistryEntry", () => {
	it("reads pid + sessionId off a registry file", () => {
		const raw = `{"pid":58920,"sessionId":"${SID_A}","cwd":"/repo","status":"busy"}`;
		assert.deepStrictEqual(parseSessionRegistryEntry(raw), {pid: 58920, sessionId: SID_A});
	});

	it("rejects an entry with no usable pid or no session id", () => {
		assert.isNull(parseSessionRegistryEntry(`{"sessionId":"${SID_A}"}`));
		assert.isNull(parseSessionRegistryEntry(`{"pid":0,"sessionId":"${SID_A}"}`));
		assert.isNull(parseSessionRegistryEntry(`{"pid":-1,"sessionId":"${SID_A}"}`));
		assert.isNull(parseSessionRegistryEntry(`{"pid":1.5,"sessionId":"${SID_A}"}`));
		assert.isNull(parseSessionRegistryEntry('{"pid":42,"sessionId":"nope"}'));
		assert.isNull(parseSessionRegistryEntry("garbage"));
		assert.isNull(parseSessionRegistryEntry("null"));
	});
});
