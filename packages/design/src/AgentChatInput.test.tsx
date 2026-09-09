import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {Paperclip} from "lucide-react";
import {createRef, useRef} from "react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {AgentChatInput} from "./AgentChatInput";
import {useAgentChatInput} from "./agent-chat/Root";
import type {AgentChatInputBridge, PiEvent} from "./agent-chat-bridge";
import {Form, Input} from "./Form";
import {type DesignTranslate, DesignTranslationProvider, defaultDesignTranslate} from "./i18n";

function response(body: unknown): Response {
	return new Response(JSON.stringify(body), {headers: {"Content-Type": "application/json"}});
}

function installHarnessFetch(): {
	fetch: ReturnType<typeof vi.fn>;
	bridge: AgentChatInputBridge;
	push: (event: PiEvent) => void;
} {
	let listener: ((event: PiEvent) => void) | null = null;
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
			return [{name: "skill:review", description: "İncele ve geri bildir."}];
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
		subscribeToPiEvents: (onEvent) => {
			listener = onEvent;
			return () => {
				if (listener === onEvent) listener = null;
			};
		},
	};
	return {fetch, bridge, push: (event) => listener?.(event)};
}

/**
 * A host that knows nothing at mount and pushes its catalog once it does. This is the shape a host
 * whose agent starts after the composer does has to take: the four loads run once per bridge
 * identity, so rebuilding the bridge to deliver a late catalog would drop the composer back to
 * `loading` on every change.
 */
function lateCatalogBridge(): {
	bridge: AgentChatInputBridge;
	push: (event: {readonly type: string; readonly [key: string]: unknown}) => void;
} {
	let listener: ((event: {readonly type: string; readonly [key: string]: unknown}) => void) | null =
		null;
	const bridge: AgentChatInputBridge = {
		loadPiState: async () => ({isStreaming: false}),
		loadPiCommands: async () => [],
		// `undefined`, not `[]`: this host does not know what it offers yet, which is a different
		// answer from knowing it offers nothing (#8425).
		loadPiModels: async () => undefined,
		loadPiThinkingLevels: async () => undefined,
		loadPiFiles: async () => [],
		setPiModel: async () => undefined,
		setPiThinkingLevel: async () => undefined,
		setPiProjectTrust: async () => undefined,
		sendPiPrompt: async () => undefined,
		abortPi: async () => undefined,
		answerPiExtension: async () => undefined,
		subscribeToPiEvents: (onEvent) => {
			listener = onEvent;
			return () => {
				listener = null;
			};
		},
	};
	return {bridge, push: (event) => listener?.(event)};
}

/**
 * Two providers offering one display name — the founder's desk, where `openai` and `openai-codex`
 * both carry `GPT-5.6 Luna` (#8065). A row's name alone cannot name one of them.
 */
function collidingCatalogBridge(): {
	bridge: AgentChatInputBridge;
	picks: Array<{readonly provider: string; readonly id: string}>;
} {
	const luna = {provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna"};
	const codexLuna = {provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna"};
	const picks: Array<{readonly provider: string; readonly id: string}> = [];
	let model = luna;
	const bridge: AgentChatInputBridge = {
		loadPiState: async () => ({isStreaming: false, model, thinkingLevel: "medium"}),
		loadPiCommands: async () => [],
		loadPiModels: async () => [luna, codexLuna],
		loadPiThinkingLevels: async () => ["medium", "high"],
		loadPiFiles: async () => [],
		setPiModel: async (next) => {
			picks.push({provider: next.provider, id: next.id});
			model = {provider: next.provider, id: next.id, name: next.name};
		},
		setPiThinkingLevel: async () => undefined,
		setPiProjectTrust: async () => undefined,
		sendPiPrompt: async () => undefined,
		abortPi: async () => undefined,
		answerPiExtension: async () => undefined,
		subscribeToPiEvents: () => () => undefined,
	};
	return {bridge, picks};
}

/**
 * The composer assembled from its compound parts, in the order the export assembles them. Two
 * renders never draw the same generated ids — React's `useId` and Manti's own `data-uid` both
 * count up per render — so the comparison below reads the markup with every id-carrying attribute
 * blanked.
 */
function ComposedComposer() {
	const {submit, disabled, addImage} = useAgentChatInput();
	const t = defaultDesignTranslate;
	const imageInputRef = useRef<HTMLInputElement>(null);
	return (
		<AgentChatInput.Frame>
			<AgentChatInput.Surface>
				<Form
					className="kp-agent-chat__form"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<AgentChatInput.Field />
					<div className="kp-agent-chat__actions">
						<div className="kp-agent-chat__primary-controls">
							<Input
								ref={imageInputRef}
								className="kp-visually-hidden"
								label={t("admin.agent.image.add")}
								type="file"
								accept="image/*"
								tabIndex={-1}
								onChange={(event) => {
									void addImage(event.currentTarget.files?.[0]);
									event.currentTarget.value = "";
								}}
							/>
							<AgentChatInput.Control
								icon={Paperclip}
								className="kp-agent-chat__icon-button"
								aria-label={t("admin.agent.image.add")}
								onClick={() => imageInputRef.current?.click()}
								disabled={disabled}
							/>
							<AgentChatInput.Settings />
							<AgentChatInput.Overflow />
						</div>
						<AgentChatInput.PrimaryActions />
					</div>
				</Form>
			</AgentChatInput.Surface>

			<AgentChatInput.Inspector />
			<AgentChatInput.ExtensionDialog />
		</AgentChatInput.Frame>
	);
}

const GENERATED_IDS =
	/\s(id|for|aria-controls|aria-activedescendant|aria-labelledby|aria-describedby|data-uid|data-controls)="[^"]*"/g;

/**
 * The composer paints before its catalog resolves, and the model and thinking labels are the last
 * thing the four bridge loads move. Reading the markup before they land compares half-settled
 * trees, which goes red on timing rather than on a difference.
 */
async function settleComposer(): Promise<void> {
	await screen.findAllByText("GPT-5");
	await screen.findAllByText("orta");
}

/**
 * Drives the three parts that render nothing at rest: `Inspector` has no activity to list until
 * the harness pushes one and stays folded until the disclosure is opened; `ExtensionDialog` is
 * `null` until a request is outstanding. Without this the parity comparison reads empty against
 * empty and proves nothing about them (#8711).
 */
async function driveComposerParts(push: (event: PiEvent) => void): Promise<void> {
	act(() => {
		push({type: "tool_execution_start", toolName: "Read"});
		push({
			type: "extension_ui_request",
			id: "ext-1",
			method: "input",
			title: "Dal adı",
			message: "Hangi dala geçelim?",
			placeholder: "umut/…",
		});
	});
	fireEvent.click(await screen.findByRole("button", {name: /Pi denetçisi/}));
	await screen.findByText("Pi Read kullanıyor.");
	await screen.findByRole("dialog");
}

/**
 * Everything the composer paints: the `Frame` section with its own attributes — its class and the
 * label the whole composer is named off — and the overlay `ExtensionDialog` raises, which
 * Manti portals to `document.body` and so lands beside the render container rather than inside it.
 * Two renders never draw the same generated ids — React's `useId` and Manti's own `data-uid` both
 * count up per render — so every id-carrying attribute is blanked.
 */
function composerMarkup(container: HTMLElement): string {
	const frame = container.querySelector("section.kp-agent-chat");
	if (!frame) throw new Error("no composer rendered");
	const portaled = Array.from(document.body.children).filter(
		(child) => child !== container && child.getAttribute("data-scope") === "dialog",
	);
	return [frame, ...portaled]
		.map((element) => element.outerHTML)
		.join("\n")
		.replace(GENERATED_IDS, ' $1="*"');
}

afterEach(() => vi.unstubAllGlobals());

describe("AgentChatInput", () => {
	describe("the effort picker", () => {
		const translate: DesignTranslate = (key, params) =>
			key === "admin.agent.picker.none"
				? "No effort selected"
				: defaultDesignTranslate(key, params);
		const role = "button";
		const itemRole = "menuitemradio";
		const selectedAttribute = "aria-checked";

		it.each([
			{levels: ["low", "medium"] as const},
			{levels: ["low"] as const},
		])("picks from translated unset state with $levels", async ({levels}) => {
			const {bridge: emptyBridge} = lateCatalogBridge();
			let thinkingLevel: string | undefined;
			const setPiThinkingLevel = vi.fn(async (level: string) => {
				thinkingLevel = level;
			});
			const bridge: AgentChatInputBridge = {
				...emptyBridge,
				loadPiState: async () => ({
					isStreaming: false,
					...(thinkingLevel === undefined ? {} : {thinkingLevel}),
				}),
				loadPiThinkingLevels: async () => levels,
				setPiThinkingLevel,
			};
			render(
				<DesignTranslationProvider translate={translate}>
					<AgentChatInput bridge={bridge} />
				</DesignTranslationProvider>,
			);

			const picker = await screen.findByRole(role, {name: /düşünme eforu/});
			await waitFor(() => {
				expect(picker.textContent).toBe("No effort selected");
				expect(picker.getAttribute("disabled")).toBeNull();
			});
			expect(setPiThinkingLevel).not.toHaveBeenCalled();
			fireEvent.click(picker);
			const choices = await screen.findAllByRole(itemRole);
			expect(choices).toHaveLength(levels.length);
			for (const choice of choices) {
				expect(choice.getAttribute(selectedAttribute)).toBe("false");
			}
			fireEvent.click(screen.getByRole(itemRole, {name: "düşük"}));
			await waitFor(() => {
				expect(setPiThinkingLevel).toHaveBeenCalledExactlyOnceWith("low");
				expect(picker.textContent).toBe("düşük");
			});
		});

		it("keeps a supplied level selected", async () => {
			const {bridge} = installHarnessFetch();
			render(<AgentChatInput bridge={bridge} />);

			const picker = await screen.findByRole(role, {name: /düşünme eforu/});
			await waitFor(() => expect(picker.textContent).toBe("orta"));
			fireEvent.click(picker);
			expect(
				(await screen.findByRole(itemRole, {name: "orta"})).getAttribute(selectedAttribute),
			).toBe("true");
			expect(screen.getByRole(itemRole, {name: "minimal"}).getAttribute(selectedAttribute)).toBe(
				"false",
			);
		});
	});

	it("uses Pi's live command registry for slash completion", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Pi'ye mesaj yaz");

		fireEvent.change(input, {target: {value: "/rev"}});
		const command = await screen.findByRole("option", {name: /\/skill:review/i});
		fireEvent.click(command);

		expect((input as HTMLTextAreaElement).value).toBe("/skill:review ");
	});

	it("exposes the completion list through the textarea combobox contract", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Pi'ye mesaj yaz");

		expect(input.getAttribute("role")).toBe("combobox");
		expect(input.getAttribute("aria-expanded")).toBe("false");
		fireEvent.change(input, {target: {value: "/rev"}});

		const listbox = await screen.findByRole("listbox", {name: "Pi tamamlamaları"});
		const option = await screen.findByRole("option", {name: /\/skill:review/i});
		expect(input.getAttribute("aria-expanded")).toBe("true");
		expect(input.getAttribute("aria-controls")).toBe(listbox.id);
		expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
	});

	it("does not submit while an IME composition owns Enter", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Pi'ye mesaj yaz");

		fireEvent.change(input, {target: {value: "Composing text"}});
		fireEvent.keyDown(input, {key: "Enter", isComposing: true});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fetch.mock.calls.filter(([path]) => path === "/__pi/prompt")).toHaveLength(0);
	});

	it("inserts a repository-relative path from @ completion", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Pi'ye mesaj yaz");

		fireEvent.change(input, {target: {value: "@app"}});
		const file = await screen.findByRole("option", {name: /@apps\/web\/src\/App\.tsx/i});
		fireEvent.click(file);

		expect((input as HTMLTextAreaElement).value).toBe("@apps/web/src/App.tsx ");
	});

	it("changes the Pi model from the composer", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);

		fireEvent.click(await screen.findByRole("button", {name: "model: GPT-5"}));
		fireEvent.click(await screen.findByRole("menuitemradio", {name: "GPT-5.6"}));
		await waitFor(() => {
			expect(fetch).toHaveBeenCalledWith(
				"/__pi/model",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({provider: "openai", modelId: "gpt-5.6"}),
				}),
			);
		});
	});

	it("takes a catalog pushed after mount and enables the picker on it", async () => {
		const {bridge, push} = lateCatalogBridge();
		render(<AgentChatInput bridge={bridge} />);

		const before = await screen.findByRole("button", {name: /model/i});
		expect(before.getAttribute("disabled")).not.toBeNull();

		push({
			type: "harness_status",
			status: {
				models: [
					{provider: "anthropic", id: "opus", name: "Opus 5"},
					{provider: "anthropic", id: "sonnet", name: "Sonnet 5"},
				],
				model: {provider: "anthropic", id: "sonnet", name: "Sonnet 5"},
			},
		});

		const picker = await screen.findByRole("button", {name: "model: Sonnet 5"});
		await waitFor(() => expect(picker.getAttribute("disabled")).toBeNull());
		fireEvent.click(picker);
		expect(await screen.findByRole("menuitemradio", {name: "Opus 5"})).toBeTruthy();
	});

	it("takes a command catalog pushed after mount and offers it to the picker", async () => {
		const {bridge, push} = lateCatalogBridge();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Pi'ye mesaj yaz");

		fireEvent.change(input, {target: {value: "/comp"}});
		expect(screen.queryByRole("option", {name: /\/compact/})).toBeNull();

		push({
			type: "harness_status",
			status: {commands: [{name: "compact", description: "Konuşmayı özetle."}]},
		});

		fireEvent.click(await screen.findByRole("option", {name: /\/compact/}));
		expect((input as HTMLTextAreaElement).value).toBe("/compact ");
	});

	it("omits off effort returned by the bridge on load and model refresh", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);

		fireEvent.click(await screen.findByRole("button", {name: "düşünme eforu: orta"}));
		expect(await screen.findByRole("menuitemradio", {name: "minimal"})).toBeTruthy();
		expect(screen.queryByRole("menuitemradio", {name: "kapalı"})).toBeNull();
		fireEvent.click(screen.getByRole("menuitemradio", {name: "orta"}));

		fireEvent.click(screen.getByRole("button", {name: "model: GPT-5"}));
		fireEvent.click(await screen.findByRole("menuitemradio", {name: "GPT-5.6"}));
		await waitFor(() => {
			expect(fetch.mock.calls.filter(([path]) => path === "/__pi/thinking-levels")).toHaveLength(2);
			expect(screen.getByRole("button", {name: "model: GPT-5.6"})).toBeTruthy();
		});

		const refreshedThinking = screen.getByRole("button", {name: "düşünme eforu: orta"});
		await waitFor(() => expect(refreshedThinking.getAttribute("disabled")).toBeNull());
		fireEvent.click(refreshedThinking);
		expect(await screen.findByRole("menuitemradio", {name: "minimal"})).toBeTruthy();
		expect(screen.queryByRole("menuitemradio", {name: "kapalı"})).toBeNull();
	});

	it("keeps the composer's secondary controls behind the overflow menu", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);

		await screen.findByRole("button", {name: "model: GPT-5"});
		expect(screen.queryByText("yalnızca yerel atölye")).toBeNull();
		expect(screen.queryByRole("combobox", {name: "Pi teslim modu"})).toBeNull();
		expect(screen.getByRole("button", {name: "Görsel ekle"})).toBeTruthy();
		expect(screen.getByRole("button", {name: /Pi denetçisi/i})).toBeTruthy();

		fireEvent.click(screen.getByRole("button", {name: "Proje kaynakları ve gönderme ayarları"}));
		fireEvent.click(await screen.findByRole("menuitemradio", {name: "kaynakları yükleme"}));

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
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Pi'ye mesaj yaz");
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
		render(<AgentChatInput mockWhenUnavailable />);

		expect(await screen.findByRole("button", {name: "model: GPT-5.5"})).toBeTruthy();
		fireEvent.click(screen.getByRole("button", {name: "düşünme eforu: orta"}));

		expect(await screen.findByRole("menuitemradio", {name: "minimal"})).toBeTruthy();
		expect(screen.queryByRole("menuitemradio", {name: "kapalı"})).toBeNull();
	});

	it("reports every draft edit, including the clear a sent prompt performs", async () => {
		const {bridge} = installHarnessFetch();
		const drafts: string[] = [];
		render(<AgentChatInput bridge={bridge} onDraftChange={(draft) => drafts.push(draft)} />);
		const input = await screen.findByLabelText("Pi'ye mesaj yaz");

		fireEvent.change(input, {target: {value: "gönder"}});
		fireEvent.keyDown(input, {key: "Enter"});

		await waitFor(() => expect(drafts).toEqual(["gönder", ""]));
	});

	it("does not echo the value a consumer feeds back in as initialValue", async () => {
		const {bridge} = installHarnessFetch();
		const drafts: string[] = [];
		const {rerender} = render(
			<AgentChatInput bridge={bridge} initialValue="" onDraftChange={(d) => drafts.push(d)} />,
		);
		await screen.findByLabelText("Pi'ye mesaj yaz");

		rerender(
			<AgentChatInput
				bridge={bridge}
				initialValue="restored"
				onDraftChange={(d) => drafts.push(d)}
			/>,
		);

		await waitFor(() =>
			expect((screen.getByLabelText("Pi'ye mesaj yaz") as HTMLTextAreaElement).value).toBe(
				"restored",
			),
		);
		expect(drafts).toEqual([]);
	});

	it("renders the provider as a row's secondary text in the focused picker", async () => {
		const {bridge, picks} = collidingCatalogBridge();
		render(<AgentChatInput bridge={bridge} />);

		fireEvent.click(await screen.findByRole("button", {name: "model: GPT-5.6 Luna (openai)"}));
		const rows = await screen.findAllByRole("menuitemradio");
		expect(
			rows.map((row) => row.querySelector(".kp-agent-chat__picker-note")?.textContent),
		).toEqual(["openai", "openai-codex"]);
		// The name stays the row's own text; the provider is a sibling span, not part of it.
		expect(
			rows.map((row) => row.querySelector(".kp-agent-chat__picker-option > span")?.textContent),
		).toEqual(["GPT-5.6 Luna", "GPT-5.6 Luna"]);

		fireEvent.click(rows[1] as HTMLElement);
		await waitFor(() => expect(picks).toEqual([{provider: "openai-codex", id: "gpt-5.6-luna"}]));
	});

	it("leaves a single-provider catalog's rows bare", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);

		fireEvent.click(await screen.findByRole("button", {name: "model: GPT-5"}));
		const rows = await screen.findAllByRole("menuitemradio");
		expect(rows.map((row) => row.querySelector(".kp-agent-chat__picker-note"))).toEqual([
			null,
			null,
		]);
	});

	describe("the composer's compound parts", () => {
		it("assemble into the tree the plain export renders", async () => {
			const {bridge, push} = installHarnessFetch();
			const plain = render(<AgentChatInput bridge={bridge} />);
			await settleComposer();
			await driveComposerParts(push);
			const expected = composerMarkup(plain.container);
			expect(expected).toContain('class="kp-agent-chat"');
			expect(expected).toContain('aria-label="Agent chat input"');
			expect(expected).toContain("Pi Read kullanıyor.");
			expect(expected).toContain("Hangi dala geçelim?");
			plain.unmount();

			const composed = render(
				<AgentChatInput.Root bridge={bridge}>
					<ComposedComposer />
				</AgentChatInput.Root>,
			);
			await settleComposer();
			await driveComposerParts(push);
			await waitFor(() => expect(composerMarkup(composed.container)).toBe(expected));
		});
	});

	it("keeps the settings slot rendering inside the fieldset", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} settings={<button type="button">Ajan kipi</button>} />);

		const slotted = await screen.findByRole("button", {name: "Ajan kipi"});
		expect(slotted.closest("fieldset")?.className).toContain("kp-agent-chat__settings");
		expect(screen.getByRole("button", {name: "model: GPT-5"})).toBeTruthy();
	});

	it("lets Settings children stand in for the controls it owns, slot untouched", async () => {
		const {bridge} = installHarnessFetch();
		render(
			<AgentChatInput.Root bridge={bridge} settings={<button type="button">Ajan kipi</button>}>
				<AgentChatInput.Settings>
					<button type="button">Yalnız bu</button>
				</AgentChatInput.Settings>
			</AgentChatInput.Root>,
		);

		const own = await screen.findByRole("button", {name: "Yalnız bu"});
		expect(own.closest("fieldset")?.className).toContain("kp-agent-chat__settings");
		expect(screen.queryByRole("button", {name: /^model:/})).toBeNull();
		expect(screen.queryByRole("button", {name: "Ajan kipi"})).toBeNull();
	});

	// A host's only way to focus the composer, and it travels as an ordinary prop through the
	// spread onto Root. Nothing throws when it stops attaching — focus just never moves (#8688).
	it("lands a host's ref on the prompt field", async () => {
		const {bridge} = installHarnessFetch();
		const field = createRef<HTMLTextAreaElement>();
		render(<AgentChatInput bridge={bridge} ref={field} />);

		expect(await screen.findByLabelText("Pi'ye mesaj yaz")).toBe(field.current);
	});
});

/**
 * The compact shape #8669 ruled: one row that grows to a cap, and a hint that reserves no room
 * until the empty field is focused. jsdom runs no layout engine and Vitest's default `css: false`
 * drops the component's own `import "./AgentChatInput.css"`, so the height rules are read off the
 * shipped sheet's own bytes rather than off a computed box.
 */
describe("the compact composer", () => {
	const sheet = readFileSync(fileURLToPath(import.meta.resolve("./AgentChatInput.css")), "utf8");
	const fieldRule =
		sheet
			.split('.kp-agent-chat__textarea [data-scope="field"][data-part="input"]:is(textarea) {')[1]
			?.split("}")[0] ?? "";

	it("has a prompt-field rule to read", () => {
		expect(fieldRule).not.toBe("");
	});

	it("opens the prompt field at one row", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);

		const field = (await screen.findByLabelText("Pi'ye mesaj yaz")) as HTMLTextAreaElement;
		expect(field.rows).toBe(1);
	});

	it("grows the field to a cap, off the old 80px floor", () => {
		expect(sheet).not.toContain("min-height: calc(var(--s-8) * 2)");
		expect(fieldRule).toContain("field-sizing: content");
		expect(fieldRule).toContain("max-height: calc(var(--s-8) * 5)");
	});

	/*
	 * Pillar 4's floor is absolute, and the first cut of #8669 spent it: the field landed at 23px
	 * because it dropped its floor to zero, and the sheet-wide count below could not see it — a
	 * control that never names `--tap-min` is invisible to a count of `--tap-min` (#8714). So the
	 * field is asserted at its own rule, and the count stays as the tripwire for the other four.
	 */
	it("floors the prompt field at the tap target", () => {
		expect(fieldRule).toContain("min-height: var(--tap-min)");
	});

	it("leaves every toolbar control on the tap-target floor", () => {
		expect(sheet.match(/var\(--tap-min\)/g) ?? []).toHaveLength(5);
	});
});
