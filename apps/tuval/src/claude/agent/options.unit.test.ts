/**
 * The pure half: which modes a row really offers, which one a session opens on, and the environment
 * the spawned CLI runs under. Each is a plain function of the config, so none of it needs a layer.
 */

import {describe, expect, it} from "vitest";
import {Mode} from "../../ai-agent/ports/index.ts";
import {advertisedModes, type ClaudeAiAgentOptions, openingMode, sessionEnv} from "./options.ts";
import {exitDetail} from "./subprocess.ts";

const row = (over: Partial<ClaudeAiAgentOptions> = {}): ClaudeAiAgentOptions => ({
	permissionMode: Mode.make("default"),
	modes: [Mode.make("default"), Mode.make("plan")],
	allowedTools: [],
	...over,
});

describe("the modes a row offers", () => {
	it("keeps the row's own order", () => {
		expect(advertisedModes(row({modes: [Mode.make("plan"), Mode.make("default")]}))).toEqual([
			"plan",
			"default",
		]);
	});

	it("drops bypassPermissions and dontAsk, whatever the row says", () => {
		expect(
			advertisedModes(
				row({
					modes: [Mode.make("bypassPermissions"), Mode.make("dontAsk"), Mode.make("acceptEdits")],
				}),
			),
		).toEqual(["acceptEdits"]);
	});

	it("drops a mode no permission mode is named for", () => {
		expect(advertisedModes(row({modes: [Mode.make("yolo")]}))).toEqual([]);
	});
});

describe("the mode a session opens on", () => {
	it("is the row's, when the row advertises it", () => {
		expect(openingMode(row({permissionMode: Mode.make("plan")}))).toBe("plan");
	});

	it("falls back to default rather than opening on a mode the row will not offer", () => {
		expect(openingMode(row({permissionMode: Mode.make("bypassPermissions")}))).toBe("default");
	});

	// The announced mode and the session's real mode are one fact: a session opened on the row's
	// static mode while the stream said `plan` would be a lie on the stream.
	it("is the mode the layer is holding, over the row's own", () => {
		expect(openingMode(row({permissionMode: Mode.make("default")}), Mode.make("plan"))).toBe(
			"plan",
		);
	});

	it("ignores a held mode the row does not advertise", () => {
		expect(
			openingMode(row({permissionMode: Mode.make("plan")}), Mode.make("bypassPermissions")),
		).toBe("plan");
	});
});

describe("the spawned CLI's environment", () => {
	it("carries the parent's own USER through", () => {
		expect(sessionEnv({USER: "yazar", PATH: "/bin"}).USER).toBe("yazar");
	});

	// On macOS the CLI reads USER to find the keychain login, and a parent started without it (a
	// launchd agent, some CI shells) leaves the session unable to authenticate (spike #7597).
	it("fills USER in when the parent has none", () => {
		expect(sessionEnv({PATH: "/bin"}, () => "yazar").USER).toBe("yazar");
	});

	it("fills USER in when the parent's is empty", () => {
		expect(sessionEnv({USER: ""}, () => "yazar").USER).toBe("yazar");
	});

	it("changes nothing else about the parent's environment", () => {
		expect(sessionEnv({USER: "yazar", PATH: "/bin"}).PATH).toBe("/bin");
	});
});

describe("what a TransportError says the subprocess did", () => {
	it("names the exit code", () => {
		expect(exitDetail({code: 1, signal: null})).toContain("exited with code 1");
	});

	it("names the signal instead, when one killed it", () => {
		expect(exitDetail({code: null, signal: "SIGKILL"})).toContain("killed by SIGKILL");
	});

	it("says only that it ended, when no spawner was watching", () => {
		expect(exitDetail(null)).toContain("ended before the turn produced a result");
	});
});
