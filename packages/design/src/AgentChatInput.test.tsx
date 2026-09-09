import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {Paperclip} from "lucide-react";
import {createRef, useRef} from "react";
import {afterEach, describe, expect, it, vi} from "vitest";
import {AgentChatInput} from "./AgentChatInput";
import {useAgentChatInput} from "./agent-chat/Root";
import type {AgentChatInputBridge} from "./agent-chat-bridge";
import {Form, Input} from "./Form";
import {type DesignTranslate, DesignTranslationProvider, defaultDesignTranslate} from "./i18n";

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
		subscribeToPiEvents: () => () => undefined,
	};
	return {fetch, bridge};
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
	const {submit, variant, disabled, addImage} = useAgentChatInput();
	const t = defaultDesignTranslate;
	const imageInputRef = useRef<HTMLInputElement>(null);
	return (
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
						{variant === "focused" ? (
							<>
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
							</>
						) : null}
						<AgentChatInput.Settings />
						{variant === "focused" ? <AgentChatInput.Overflow /> : null}
					</div>
					<AgentChatInput.PrimaryActions />
				</div>
			</Form>
			<AgentChatInput.Hint />
		</AgentChatInput.Surface>
	);
}

const GENERATED_IDS =
	/\s(id|for|aria-controls|aria-activedescendant|aria-labelledby|aria-describedby|data-uid|data-controls)="[^"]*"/g;

/**
 * The composer paints before its catalog resolves, and the model and thinking labels are the last
 * thing the four bridge loads move. Reading the markup before they land compares half-settled
 * trees, which goes red on timing rather than on a difference.
 */
async function settledComposerMarkup(container: HTMLElement): Promise<string> {
	await screen.findAllByText("GPT-5");
	await screen.findAllByText("orta");
	return composerMarkup(container);
}

function composerMarkup(container: HTMLElement): string {
	const composer = container.querySelector('[data-testid="agent-chat-input"]');
	if (!composer) throw new Error("no composer rendered");
	return composer.innerHTML.replace(GENERATED_IDS, ' $1="*"');
}

afterEach(() => vi.unstubAllGlobals());

describe("AgentChatInput", () => {
	describe.each(["focused", "harness"] as const)("%s effort picker", (variant) => {
		const translate: DesignTranslate = (key, params) =>
			key === "admin.agent.picker.none"
				? "No effort selected"
				: defaultDesignTranslate(key, params);
		const role = variant === "focused" ? "button" : "combobox";
		const itemRole = variant === "focused" ? "menuitemradio" : "option";
		const selectedAttribute = variant === "focused" ? "aria-checked" : "aria-selected";

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
					<AgentChatInput bridge={bridge} variant={variant} />
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
			render(<AgentChatInput bridge={bridge} variant={variant} />);

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

	it("sends the selected delivery mode through the Pi bridge", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);
		const input = await screen.findByLabelText("Pi'ye mesaj yaz");

		fireEvent.change(input, {target: {value: "Review the component."}});
		fireEvent.click(screen.getByRole("combobox", {name: "Pi teslim modu"}));
		fireEvent.click(await screen.findByRole("option", {name: "sonraya al"}));
		await waitFor(() => {
			expect(screen.getByRole("combobox", {name: "Pi teslim modu"}).textContent).toBe("sonraya al");
		});
		fireEvent.click(screen.getByRole("button", {name: /gönder/i}));

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

		fireEvent.click(await screen.findByRole("combobox", {name: "Pi modeli"}));
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

		fireEvent.click(screen.getByRole("combobox", {name: "Pi düşünme eforu"}));
		fireEvent.click(await screen.findByRole("option", {name: "yüksek"}));
		await waitFor(() => {
			expect(fetch).toHaveBeenCalledWith(
				"/__pi/thinking-level",
				expect.objectContaining({method: "POST", body: JSON.stringify({level: "high"})}),
			);
		});

		fireEvent.click(screen.getByRole("combobox", {name: /Pi proje izni/i}));
		fireEvent.click(await screen.findByRole("option", {name: "yoksay"}));
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

	it("takes a catalog pushed after mount and enables the picker on it", async () => {
		const {bridge, push} = lateCatalogBridge();
		render(<AgentChatInput bridge={bridge} variant="focused" />);

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

	it("drops the slash hint on a harness that offers no commands", async () => {
		const {bridge} = lateCatalogBridge();
		render(<AgentChatInput bridge={bridge} variant="harness" />);
		await screen.findByLabelText("Pi'ye mesaj yaz");

		// The hint is the only thing advertising the sigil; typing `/` against an empty catalog opens
		// nothing, so a hint promising a picker reads as a fault rather than as a feature.
		const hint = screen.getByText(/dosya/);
		expect(hint.textContent).not.toContain("komut");
	});

	it("omits off effort returned by the bridge on load and model refresh", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} variant="focused" />);

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

	it("keeps secondary harness controls behind disclosure in the focused variant", async () => {
		const {fetch, bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} variant="focused" />);

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
		render(<AgentChatInput bridge={bridge} variant="focused" />);
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
		render(<AgentChatInput variant="focused" mockWhenUnavailable />);

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

	it("tells two providers' same-named models apart in the select list", async () => {
		const {bridge, picks} = collidingCatalogBridge();
		render(<AgentChatInput bridge={bridge} />);

		fireEvent.click(await screen.findByRole("combobox", {name: "Pi modeli"}));
		const rows = await screen.findAllByRole("option");
		expect(rows.map((row) => row.textContent)).toEqual([
			"GPT-5.6 Luna (openai)",
			"GPT-5.6 Luna (openai-codex)",
		]);

		fireEvent.click(screen.getByRole("option", {name: "GPT-5.6 Luna (openai-codex)"}));
		await waitFor(() => expect(picks).toEqual([{provider: "openai-codex", id: "gpt-5.6-luna"}]));
	});

	it("renders the provider as a row's secondary text in the focused picker", async () => {
		const {bridge, picks} = collidingCatalogBridge();
		render(<AgentChatInput bridge={bridge} variant="focused" />);

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

	it("names the running model with its provider once two providers are offered", async () => {
		const {bridge} = collidingCatalogBridge();
		render(<AgentChatInput bridge={bridge} />);

		expect(await screen.findByText(/Pi hazır · GPT-5\.6 Luna \(openai\)/)).toBeTruthy();
	});

	it("leaves a single-provider catalog's rows bare", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} />);

		fireEvent.click(await screen.findByRole("combobox", {name: "Pi modeli"}));
		expect((await screen.findAllByRole("option")).map((row) => row.textContent)).toEqual([
			"GPT-5",
			"GPT-5.6",
		]);
	});

	describe.each(["harness", "focused"] as const)("the %s composer's compound parts", (variant) => {
		it("assemble into the tree the plain export renders", async () => {
			const {bridge} = installHarnessFetch();
			const plain = render(<AgentChatInput bridge={bridge} variant={variant} />);
			const expected = await settledComposerMarkup(plain.container);
			plain.unmount();

			const composed = render(
				<AgentChatInput.Root bridge={bridge} variant={variant}>
					<ComposedComposer />
				</AgentChatInput.Root>,
			);
			await settledComposerMarkup(composed.container);
			await waitFor(() => expect(composerMarkup(composed.container)).toBe(expected));
		});
	});

	it("keeps the settings slot rendering inside the fieldset", async () => {
		const {bridge} = installHarnessFetch();
		render(<AgentChatInput bridge={bridge} settings={<button type="button">Ajan kipi</button>} />);

		const slotted = await screen.findByRole("button", {name: "Ajan kipi"});
		expect(slotted.closest("fieldset")?.className).toContain("kp-agent-chat__settings");
		expect(screen.getByRole("combobox", {name: "Pi modeli"})).toBeTruthy();
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
		expect(screen.queryByRole("combobox", {name: "Pi modeli"})).toBeNull();
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
