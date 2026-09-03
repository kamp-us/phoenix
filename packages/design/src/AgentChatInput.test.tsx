import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {AgentChatInput} from "./AgentChatInput";
import type {AgentChatInputBridge} from "./agent-chat-bridge";

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {headers: {"Content-Type": "application/json"}});
}

function installHarnessFetch(): {
	fetch: ReturnType<typeof vi.fn>;
	bridge: AgentChatInputBridge;
} {
	let model = {provider: "openai", id: "gpt-5", name: "GPT-5"};
	let thinkingLevel = "medium";
	let projectTrust = "approve";
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = String(input);
		if (path === "/__pi/state")
			return response({state: {isStreaming: false, model, thinkingLevel}, projectTrust});
		if (path === "/__pi/commands") {
			return response({
				commands: {
					commands: [{name: "skill:review", description: "Review and report."}],
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
			return response({levels: {levels: ["off", "minimal", "low", "medium", "high"]}});
		}
		if (path.startsWith("/__pi/files")) return response({files: ["apps/web/src/App.tsx"]});
		if (path === "/__pi/model") {
			const body = JSON.parse(String(init?.body));
			model = {
				provider: body.provider,
				id: body.modelId,
				name: body.modelId === "gpt-5.6" ? "GPT-5.6" : "GPT-5",
			};
			return response({model});
		}
		if (path === "/__pi/thinking-level") {
			thinkingLevel = JSON.parse(String(init?.body)).level;
			return response({thinkingLevel});
		}
		if (path === "/__pi/project-trust") {
			projectTrust = JSON.parse(String(init?.body)).projectTrust;
			return response({projectTrust});
		}
		if (path === "/__pi/prompt") return response({accepted: {}});
		throw new Error(`Unexpected harness request: ${path} ${String(init?.method)}`);
	});
	vi.stubGlobal("fetch", fetch);
	const request = async (path: string, init?: RequestInit): Promise<void> => {
		await fetch(path, init);
	};
	const bridge: AgentChatInputBridge = {
		loadPiState: async () => {
			await request("/__pi/state");
			return {isStreaming: false, model, thinkingLevel, projectTrust};
		},
		loadPiCommands: async () => {
			await request("/__pi/commands");
			return [{name: "skill:review", description: "Review and report."}];
		},
		loadPiModels: async () => {
			await request("/__pi/models");
			return [model, {provider: "openai", id: "gpt-5.6", name: "GPT-5.6"}];
		},
		loadPiThinkingLevels: async () => {
			await request("/__pi/thinking-levels");
			return ["off", "minimal", "low", "medium", "high"];
		},
		loadPiFiles: async () => {
			await request("/__pi/files?q=app");
			return ["apps/web/src/App.tsx"];
		},
		setPiModel: async (nextModel) => {
			await request("/__pi/model", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify({provider: nextModel.provider, modelId: nextModel.id}),
			});
			model = nextModel;
		},
		setPiThinkingLevel: async (nextLevel) => {
			await request("/__pi/thinking-level", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify({level: nextLevel}),
			});
			thinkingLevel = nextLevel;
		},
		setPiProjectTrust: async (nextProjectTrust) => {
			await request("/__pi/project-trust", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify({projectTrust: nextProjectTrust}),
			});
			projectTrust = nextProjectTrust;
		},
		sendPiPrompt: async (options) => {
			await request("/__pi/prompt", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify(options),
			});
		},
		abortPi: () => request("/__pi/abort", {method: "POST"}),
		answerPiExtension: (answer) =>
			request("/__pi/extension-response", {
				method: "POST",
				headers: {"Content-Type": "application/json"},
				body: JSON.stringify(answer),
			}),
		subscribeToPiEvents: () => () => undefined,
	};
	return {fetch, bridge};
}

afterEach(() => vi.unstubAllGlobals());

describe("AgentChatInput", () => {
	it("uses Pi's live command registry for slash completion", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Write a message to Pi");

		fireEvent.change(input, {target: {value: "/rev"}});
		const command = await screen.findByRole("option", {name: /\/skill:review/i});
		fireEvent.click(command);

		expect((input as HTMLTextAreaElement).value).toBe("/skill:review ");
	});

	it("exposes the completion list through the textarea combobox contract", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Write a message to Pi");

		expect(input.getAttribute("role")).toBe("combobox");
		expect(input.getAttribute("aria-expanded")).toBe("false");
		fireEvent.change(input, {target: {value: "/rev"}});

		const listbox = await screen.findByRole("listbox", {name: "Pi completions"});
		const option = await screen.findByRole("option", {name: /\/skill:review/i});
		expect(input.getAttribute("aria-expanded")).toBe("true");
		expect(input.getAttribute("aria-controls")).toBe(listbox.id);
		expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
	});

	it("does not submit while an IME composition owns Enter", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Write a message to Pi");

		fireEvent.change(input, {target: {value: "Composing text"}});
		fireEvent.keyDown(input, {key: "Enter", isComposing: true});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fetch.mock.calls.filter(([path]) => path === "/__pi/prompt")).toHaveLength(0);
	});

	it("inserts a repository-relative path from @ completion", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Write a message to Pi");

		fireEvent.change(input, {target: {value: "@app"}});
		const file = await screen.findByRole("option", {name: /@apps\/web\/src\/App\.tsx/i});
		fireEvent.click(file);

		expect((input as HTMLTextAreaElement).value).toBe("@apps/web/src/App.tsx ");
	});

	it("sends the selected delivery mode through the Pi bridge", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Write a message to Pi");

		fireEvent.change(input, {target: {value: "Review the component."}});
		fireEvent.click(screen.getByRole("combobox", {name: "Pi delivery mode"}));
		fireEvent.click(await screen.findByRole("option", {name: "follow up"}));
		await waitFor(() => {
			expect(screen.getByRole("combobox", {name: "Pi delivery mode"}).textContent).toBe(
				"follow up",
			);
		});
		fireEvent.click(screen.getByRole("button", {name: /send/i}));

		await waitFor(() => {
			expect(fetch).toHaveBeenCalledWith(
				"/__pi/prompt",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({type: "follow_up", message: "Review the component."}),
				}),
			);
		});
	});

	it("changes Pi model, effort, and project trust from the composer", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);

		fireEvent.click(await screen.findByRole("combobox", {name: "Pi model"}));
		fireEvent.click(await screen.findByRole("option", {name: "GPT-5.6"}));
		await waitFor(() => {
			expect(fetch).toHaveBeenCalledWith(
				"/__pi/model",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({provider: "openai", modelId: "gpt-5.6"}),
				}),
			);
		});

		fireEvent.click(screen.getByRole("combobox", {name: "Pi thinking effort"}));
		fireEvent.click(await screen.findByRole("option", {name: "high"}));
		await waitFor(() => {
			expect(fetch).toHaveBeenCalledWith(
				"/__pi/thinking-level",
				expect.objectContaining({method: "POST", body: JSON.stringify({level: "high"})}),
			);
		});

		fireEvent.click(screen.getByRole("combobox", {name: /Pi project trust/i}));
		fireEvent.click(await screen.findByRole("option", {name: "skip resources"}));
		await waitFor(() => {
			expect(fetch).toHaveBeenCalledWith(
				"/__pi/project-trust",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({projectTrust: "no-approve"}),
				}),
			);
		});
	});

	it("keeps secondary harness controls behind disclosure in the focused variant", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} variant="focused" />);

		await screen.findByRole("button", {name: "model: GPT-5"});
		expect(screen.queryByText("local workshop only")).toBeNull();
		expect(screen.queryByRole("combobox", {name: "Pi delivery mode"})).toBeNull();
		expect(screen.getByRole("button", {name: "Add image"})).toBeTruthy();
		expect(screen.getByRole("button", {name: /Pi inspector/i})).toBeTruthy();

		fireEvent.click(screen.getByRole("button", {name: "Project resources and delivery settings"}));
		fireEvent.click(await screen.findByRole("menuitemradio", {name: "skip resources"}));

		await waitFor(() => {
			expect(fetch).toHaveBeenCalledWith(
				"/__pi/project-trust",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({projectTrust: "no-approve"}),
				}),
			);
		});
	});

	it("adds an image pasted from clipboard items", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} variant="focused" />);
		const input = await screen.findByLabelText("Write a message to Pi");
		const image = new File([new Uint8Array([137, 80, 78, 71])], "ekran.png", {
			type: "image/png",
		});

		fireEvent.paste(input, {
			clipboardData: {
				files: [],
				items: [{kind: "file", type: "image/png", getAsFile: () => image}],
			},
		});

		expect(await screen.findByText("ekran.png")).toBeTruthy();
	});

	it("shows mock controls in deploy previews and omits the off effort", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response({})),
		);
		render(<AgentChatInput variant="focused" mockWhenUnavailable />);

		expect(await screen.findByRole("button", {name: "model: GPT-5.5"})).toBeTruthy();
		fireEvent.click(screen.getByRole("button", {name: "thinking effort: medium"}));

		expect(await screen.findByRole("menuitemradio", {name: "minimal"})).toBeTruthy();
		expect(screen.queryByRole("menuitemradio", {name: "off"})).toBeNull();
	});
});
