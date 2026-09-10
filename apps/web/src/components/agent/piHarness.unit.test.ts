import {afterEach, describe, expect, it, vi} from "vitest";
import {agentChatInputBridge} from "./piHarness.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Pi composer thinking boundary", () => {
	it("refuses the shared ultra level without sending it to Pi", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		await expect(agentChatInputBridge.setPiThinkingLevel("ultra")).rejects.toThrow(
			"Pi does not support",
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
