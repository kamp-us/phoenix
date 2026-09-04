import {AgentChatInput} from "@kampus/design";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {agentChatInputBridge} from "./piHarness";

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {headers: {"Content-Type": "application/json"}});
}

afterEach(() => vi.unstubAllGlobals());

describe("AgentChatInput production bridge", () => {
	it("renders Pi responses and sends prompts through the app-owned adapter", async () => {
		const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			if (path === "/__pi/state") {
				return response({
					state: {
						isStreaming: false,
						model: {provider: "openai", id: "gpt-5", name: "GPT-5"},
						thinkingLevel: "medium",
					},
					projectTrust: "approve",
				});
			}
			if (path === "/__pi/commands") {
				return response({
					commands: {
						commands: [{name: "skill:review", description: "İncele ve geri bildir."}],
					},
				});
			}
			if (path === "/__pi/models") {
				return response({
					models: {
						models: [
							{provider: "openai", id: "gpt-5", name: "GPT-5"},
							{provider: "openai", id: "gpt-5.6", name: "GPT-5.6"},
						],
					},
				});
			}
			if (path === "/__pi/thinking-levels") {
				return response({levels: {levels: ["off", "minimal", "medium", "high"]}});
			}
			if (path === "/__pi/prompt") return response({accepted: {id: "prompt-1"}});
			throw new Error(`Unexpected harness request: ${path}`);
		});
		vi.stubGlobal("fetch", fetch);

		render(<AgentChatInput bridge={agentChatInputBridge} />);
		const input = await screen.findByLabelText("Pi'ye mesaj yaz");

		expect(await screen.findByText("Pi hazır · GPT-5")).toBeTruthy();
		fireEvent.change(input, {target: {value: "/rev"}});
		expect(await screen.findByRole("option", {name: /\/skill:review/i})).toBeTruthy();

		fireEvent.change(input, {target: {value: "Merhaba Pi"}});
		fireEvent.click(screen.getByRole("button", {name: /gönder/i}));

		await waitFor(() => {
			expect(fetch).toHaveBeenCalledWith(
				"/__pi/prompt",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({type: "prompt", message: "Merhaba Pi"}),
				}),
			);
		});
		expect(await screen.findByText("İstem Pi'ye gönderildi.")).toBeTruthy();
	});
});
