import {
	Bot,
	Brain,
	ChevronDown,
	ChevronsDown,
	ChevronsUp,
	ChevronUp,
	CircleOff,
	File as FileIcon,
	FileImage,
	type LucideIcon,
	Minus,
	Paperclip,
	SendHorizontal,
	ShieldCheck,
	Sparkles,
	Square,
	Terminal,
	X,
} from "lucide-react";
import {
	type ClipboardEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {type CatalogKey, type Translate, useT} from "../../i18n";
import {Icon} from "../Icon";
import {Alert} from "../ui/Alert";
import {Kbd} from "../ui/atoms";
import {Button} from "../ui/Button";
import {Card} from "../ui/Card";
import {Collapsible} from "../ui/Collapsible";
import {Dialog} from "../ui/Dialog";
import {Form, Input, Textarea} from "../ui/Form";
import {Menu, type MenuItem} from "../ui/Menu";
import {Select, type SelectItem} from "../ui/Select";
import {
	abortPi,
	answerPiExtension,
	loadPiCommands,
	loadPiFiles,
	loadPiModels,
	loadPiState,
	loadPiThinkingLevels,
	type PiCommand,
	type PiDeliveryMode,
	type PiEvent,
	type PiExtensionAnswer,
	type PiImage,
	type PiModel,
	type PiProjectTrust,
	type PiThinkingLevel,
	sendPiPrompt,
	setPiModel,
	setPiProjectTrust,
	setPiThinkingLevel,
	subscribeToPiEvents,
} from "./piHarness";
import "./AgentChatInput.css";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const deliveryModeKeys: readonly {value: PiDeliveryMode; key: CatalogKey}[] = [
	{value: "prompt", key: "admin.agent.delivery.prompt"},
	{value: "steer", key: "admin.agent.delivery.steer"},
	{value: "follow_up", key: "admin.agent.delivery.followUp"},
];

const projectTrustKeys: readonly {value: PiProjectTrust; key: CatalogKey}[] = [
	{value: "approve", key: "admin.agent.trust.approve"},
	{value: "no-approve", key: "admin.agent.trust.ignore"},
];

const thinkingLevelKeys: Readonly<Record<PiThinkingLevel, CatalogKey>> = {
	off: "admin.agent.thinking.off",
	minimal: "admin.agent.thinking.minimal",
	low: "admin.agent.thinking.low",
	medium: "admin.agent.thinking.medium",
	high: "admin.agent.thinking.high",
	xhigh: "admin.agent.thinking.xhigh",
	max: "admin.agent.thinking.max",
};

const toItems = (
	entries: readonly {value: string; key: CatalogKey}[],
	t: Translate,
): SelectItem[] => entries.map(({value, key}) => ({value, label: t(key)}));

const thinkingLevelIcons: Readonly<Record<PiThinkingLevel, LucideIcon>> = {
	off: CircleOff,
	minimal: ChevronsDown,
	low: ChevronDown,
	medium: Minus,
	high: ChevronUp,
	xhigh: ChevronsUp,
	max: Sparkles,
};

const mockModels: readonly PiModel[] = [
	{provider: "openai", id: "gpt-5.5", name: "GPT-5.5"},
	{provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna"},
	{provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol"},
	{provider: "openai", id: "gpt-5.6-terra", name: "GPT-5.6 Terra"},
];

const mockThinkingLevels: readonly PiThinkingLevel[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

const mockCommands = (t: Translate): readonly PiCommand[] => [
	{name: "review", description: t("admin.agent.mock.command.review")},
	{name: "compact", description: t("admin.agent.mock.command.compact")},
];

const mockFiles = ["apps/web/src/App.tsx", "apps/web/src/components/agent/AgentChatInput.tsx"];

type ConnectionState = "loading" | "ready" | "unavailable" | "working";

interface Completion {
	readonly kind: "command" | "file";
	readonly query: string;
	readonly start: number;
	readonly end: number;
}

type Suggestion =
	| {readonly kind: "command"; readonly command: PiCommand}
	| {readonly kind: "file"; readonly path: string};

interface Activity {
	readonly id: number;
	readonly text: string;
}

interface PickerItem {
	readonly value: string;
	readonly label: string;
	readonly icon?: LucideIcon;
}

interface ExtensionRequest {
	readonly id: string;
	readonly method: "select" | "confirm" | "input" | "editor";
	readonly title: string;
	readonly message?: string;
	readonly options?: readonly string[];
	readonly placeholder?: string;
	readonly prefill?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function booleanValue(record: Record<string, unknown>, key: string): boolean | undefined {
	const value = record[key];
	return typeof value === "boolean" ? value : undefined;
}

function deliveryMode(value: string | undefined): PiDeliveryMode | undefined {
	return value === "prompt" || value === "steer" || value === "follow_up" ? value : undefined;
}

function projectTrustValue(value: unknown): PiProjectTrust | undefined {
	return value === "approve" || value === "no-approve" ? value : undefined;
}

function thinkingLevelValue(value: unknown): PiThinkingLevel | undefined {
	return value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
		? value
		: undefined;
}

function modelValue(model: Pick<PiModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function selectedModelValue(state: Record<string, unknown> | undefined): string | undefined {
	const model = state && isRecord(state.model) ? state.model : undefined;
	if (!model) return undefined;
	const provider = stringValue(model, "provider");
	const id = stringValue(model, "id");
	return provider && id ? modelValue({provider, id}) : undefined;
}

function completionFor(draft: string): Completion | undefined {
	const match = /(?:^|\s)([/@])([^\s]*)$/.exec(draft);
	if (!match) return undefined;
	const sigil = match[1];
	const query = match[2] ?? "";
	if (!sigil) return undefined;
	const start = draft.length - match[0].length + match[0].lastIndexOf(sigil);
	return {kind: sigil === "/" ? "command" : "file", query, start, end: draft.length};
}

function modelName(state: Record<string, unknown> | undefined): string | undefined {
	const model = state && isRecord(state.model) ? state.model : undefined;
	if (!model) return undefined;
	return (
		stringValue(model, "displayName") ?? stringValue(model, "name") ?? stringValue(model, "id")
	);
}

function assistantMessageText(value: unknown): string | undefined {
	if (!isRecord(value) || value.role !== "assistant" || !Array.isArray(value.content))
		return undefined;
	const text = value.content.flatMap((block) => {
		if (!isRecord(block)) return [];
		const value = stringValue(block, "text");
		return value ? [value] : [];
	});
	return text.length > 0 ? text.join("") : undefined;
}

function extensionRequest(event: PiEvent, fallbackTitle: string): ExtensionRequest | undefined {
	if (event.type !== "extension_ui_request") return undefined;
	const id = stringValue(event, "id");
	const rawMethod = stringValue(event, "method");
	const title = stringValue(event, "title") ?? fallbackTitle;
	if (!id || !rawMethod) return undefined;
	if (
		rawMethod !== "select" &&
		rawMethod !== "confirm" &&
		rawMethod !== "input" &&
		rawMethod !== "editor"
	) {
		return undefined;
	}
	const options = Array.isArray(event.options)
		? event.options.filter((option): option is string => typeof option === "string")
		: undefined;
	return {
		id,
		method: rawMethod,
		title,
		...(stringValue(event, "message") ? {message: stringValue(event, "message")} : {}),
		...(options && options.length > 0 ? {options} : {}),
		...(stringValue(event, "placeholder") ? {placeholder: stringValue(event, "placeholder")} : {}),
		...(stringValue(event, "prefill") ? {prefill: stringValue(event, "prefill")} : {}),
	};
}

function fileAsImage(file: File, unreadable: string): Promise<PiImage> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(unreadable));
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error(unreadable));
				return;
			}
			const data = reader.result.split(",", 2)[1];
			if (!data) {
				reject(new Error(unreadable));
				return;
			}
			resolve({data, mimeType: file.type, name: file.name});
		};
		reader.readAsDataURL(file);
	});
}

export interface AgentChatInputProps {
	readonly initialValue?: string;
	readonly disabled?: boolean;
	readonly variant?: "harness" | "focused";
	readonly mockWhenUnavailable?: boolean;
}

export function AgentChatInput({
	initialValue = "",
	disabled = false,
	variant = "harness",
	mockWhenUnavailable = false,
}: AgentChatInputProps) {
	const t = useT();
	const inputId = useId();
	const imageInputRef = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState(initialValue);
	const [delivery, setDelivery] = useState<PiDeliveryMode>("prompt");
	const [connection, setConnection] = useState<ConnectionState>("loading");
	const [state, setState] = useState<Record<string, unknown>>();
	const [commands, setCommands] = useState<readonly PiCommand[]>([]);
	const [models, setModels] = useState<readonly PiModel[]>([]);
	const [thinkingLevels, setThinkingLevels] = useState<readonly PiThinkingLevel[]>([]);
	const [projectTrust, setProjectTrust] = useState<PiProjectTrust>("approve");
	const [settingsChanging, setSettingsChanging] = useState(false);
	const [files, setFiles] = useState<readonly string[]>([]);
	const [images, setImages] = useState<readonly PiImage[]>([]);
	const [error, setError] = useState<string>();
	const [assistantText, setAssistantText] = useState("");
	const [activities, setActivities] = useState<readonly Activity[]>([]);
	const [activeSuggestion, setActiveSuggestion] = useState(0);
	const [completionDismissed, setCompletionDismissed] = useState(false);
	const [extension, setExtension] = useState<ExtensionRequest>();
	const [extensionStatus, setExtensionStatus] = useState<string>();
	const [widget, setWidget] = useState<readonly string[]>();
	const [inspectorOpen, setInspectorOpen] = useState(false);
	const [usingMockHarness, setUsingMockHarness] = useState(false);

	useEffect(() => setDraft(initialValue), [initialValue]);

	useEffect(() => {
		let current = true;
		let unsubscribe: () => void = () => undefined;
		const applyMockHarness = () => {
			setUsingMockHarness(true);
			setCommands(mockCommands(t));
			setModels(mockModels);
			setThinkingLevels(mockThinkingLevels);
			applyState({
				isStreaming: false,
				model: mockModels[0],
				thinkingLevel: "medium",
				projectTrust: "approve",
			});
			setError(undefined);
		};
		void Promise.all([loadPiState(), loadPiCommands(), loadPiModels(), loadPiThinkingLevels()])
			.then(([nextState, nextCommands, nextModels, nextThinkingLevels]) => {
				if (!current) return;
				const selectableThinkingLevels = nextThinkingLevels.filter((level) => level !== "off");
				if (
					mockWhenUnavailable &&
					(nextModels.length === 0 || selectableThinkingLevels.length === 0)
				) {
					applyMockHarness();
					return;
				}
				applyState(nextState);
				setCommands(nextCommands);
				setModels(nextModels);
				setThinkingLevels(selectableThinkingLevels);
				unsubscribe = subscribeToPiEvents(
					(event) => {
						if (current) handleEvent(event);
					},
					() => {
						if (current) setConnection("unavailable");
					},
				);
			})
			.catch((cause: unknown) => {
				if (!current) return;
				if (mockWhenUnavailable) {
					applyMockHarness();
					return;
				}
				setConnection("unavailable");
				setError(cause instanceof Error ? cause.message : t("admin.agent.error.connect"));
			});
		return () => {
			current = false;
			unsubscribe();
		};
	}, [mockWhenUnavailable, t]);

	function applyState(nextState: Record<string, unknown>) {
		setState(nextState);
		const nextProjectTrust = projectTrustValue(nextState.projectTrust);
		if (nextProjectTrust) setProjectTrust(nextProjectTrust);
		setConnection(booleanValue(nextState, "isStreaming") ? "working" : "ready");
	}

	const completion = useMemo(() => completionFor(draft), [draft]);
	useEffect(() => {
		if (completion?.kind !== "file" || completionDismissed) {
			setFiles([]);
			return;
		}
		let current = true;
		const timer = window.setTimeout(() => {
			if (usingMockHarness) {
				const query = completion.query.toLocaleLowerCase();
				setFiles(mockFiles.filter((path) => path.toLocaleLowerCase().includes(query)));
				return;
			}
			void loadPiFiles(completion.query)
				.then((nextFiles) => {
					if (current) setFiles(nextFiles);
				})
				.catch(() => {
					if (current) setFiles([]);
				});
		}, 100);
		return () => {
			current = false;
			window.clearTimeout(timer);
		};
	}, [completion, completionDismissed, usingMockHarness]);

	const suggestions = useMemo<readonly Suggestion[]>(() => {
		if (!completion || completionDismissed) return [];
		if (completion.kind === "file") return files.map((path) => ({kind: "file", path}));
		const query = completion.query.toLocaleLowerCase();
		return commands
			.filter((command) => command.name.toLocaleLowerCase().includes(query))
			.slice(0, 8)
			.map((command) => ({kind: "command", command}));
	}, [commands, completion, completionDismissed, files]);

	useEffect(() => setActiveSuggestion(0), [completion?.kind, completion?.query]);

	function addActivity(text: string) {
		setActivities((current) => [...current, {id: Date.now(), text}].slice(-4));
	}

	function handleEvent(event: PiEvent) {
		if (event.type === "agent_start") {
			setConnection("working");
			addActivity(t("admin.agent.activity.started"));
			return;
		}
		if (event.type === "agent_settled") {
			setConnection("ready");
			addActivity(t("admin.agent.activity.settled"));
			return;
		}
		if (event.type === "message_update") {
			const update = isRecord(event.assistantMessageEvent)
				? event.assistantMessageEvent
				: undefined;
			if (update?.type === "text_delta") {
				const delta = stringValue(update, "delta");
				if (delta) setAssistantText((text) => `${text}${delta}`);
			}
			return;
		}
		if (event.type === "message_end") {
			const text = assistantMessageText(event.message);
			if (text) setAssistantText(text);
			return;
		}
		if (event.type === "tool_execution_start") {
			const tool = stringValue(event, "toolName") ?? t("admin.agent.activity.toolFallback");
			addActivity(t("admin.agent.activity.tool", {tool}));
			return;
		}
		if (event.type === "harness_status") {
			const status = isRecord(event.status) ? event.status : undefined;
			const nextProjectTrust = status && projectTrustValue(status.projectTrust);
			if (nextProjectTrust) setProjectTrust(nextProjectTrust);
			if (status && booleanValue(status, "available") === false) setConnection("unavailable");
			return;
		}
		if (event.type !== "extension_ui_request") return;
		const request = extensionRequest(event, t("admin.agent.extension.title"));
		if (request) {
			setExtension(request);
			return;
		}
		const method = stringValue(event, "method");
		if (method === "notify") {
			const message = stringValue(event, "message");
			if (message) addActivity(message);
			return;
		}
		if (method === "setStatus") {
			setExtensionStatus(stringValue(event, "statusText"));
			return;
		}
		if (method === "setWidget") {
			const lines = Array.isArray(event.widgetLines)
				? event.widgetLines.filter((line): line is string => typeof line === "string")
				: undefined;
			setWidget(lines && lines.length > 0 ? lines : undefined);
			return;
		}
		if (method === "set_editor_text") {
			const text = stringValue(event, "text");
			if (text !== undefined) setDraft(text);
			return;
		}
		if (method === "setTitle") {
			const title = stringValue(event, "title");
			if (title) document.title = title;
		}
	}

	function selectSuggestion(suggestion: Suggestion) {
		if (!completion) return;
		const replacement =
			suggestion.kind === "command" ? `/${suggestion.command.name}` : `@${suggestion.path}`;
		setDraft(
			(current) =>
				`${current.slice(0, completion.start)}${replacement} ${current.slice(completion.end)}`,
		);
		setCompletionDismissed(true);
	}

	async function submit() {
		const message = draft.trim();
		if ((!message && images.length === 0) || disabled || connection === "unavailable") return;
		setError(undefined);
		if (usingMockHarness) {
			addActivity(t("admin.agent.mock.prompted"));
			setAssistantText(t("admin.agent.mock.reply"));
			setDraft("");
			setImages([]);
			return;
		}
		try {
			const requestedDelivery =
				variant === "focused"
					? connection === "working"
						? delivery === "prompt"
							? "follow_up"
							: delivery
						: "prompt"
					: delivery;
			const streamedPrompt = connection === "working" && requestedDelivery === "prompt";
			await sendPiPrompt({
				type: requestedDelivery,
				message: message || t("admin.agent.imageOnlyPrompt"),
				...(images.length > 0 ? {images} : {}),
				...(streamedPrompt ? {streamingBehavior: "steer"} : {}),
			});
			addActivity(
				t(
					streamedPrompt
						? "admin.agent.activity.steered"
						: requestedDelivery === "prompt"
							? "admin.agent.activity.prompted"
							: requestedDelivery === "steer"
								? "admin.agent.activity.steerQueued"
								: "admin.agent.activity.followUpQueued",
				),
			);
			setDraft("");
			setImages([]);
			setAssistantText("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("admin.agent.error.send"));
		}
	}

	async function stop() {
		if (usingMockHarness) {
			setConnection("ready");
			addActivity(t("admin.agent.mock.stopped"));
			return;
		}
		try {
			await abortPi();
			addActivity(t("admin.agent.activity.stopped"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("admin.agent.error.stop"));
		}
	}

	async function changeModel(value: string | undefined) {
		const nextModel = models.find((model) => modelValue(model) === value);
		if (!nextModel || value === selectedModelValue(state)) return;
		if (usingMockHarness) {
			setState((current) => ({...(current ?? {}), model: nextModel}));
			addActivity(t("admin.agent.mock.modelChanged", {model: nextModel.name}));
			return;
		}
		setSettingsChanging(true);
		setError(undefined);
		try {
			await setPiModel(nextModel);
			const [nextState, nextThinkingLevels] = await Promise.all([
				loadPiState(),
				loadPiThinkingLevels(),
			]);
			applyState(nextState);
			setThinkingLevels(nextThinkingLevels);
			addActivity(t("admin.agent.activity.modelChanged", {model: nextModel.name}));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("admin.agent.error.model"));
		} finally {
			setSettingsChanging(false);
		}
	}

	async function changeThinkingLevel(value: string | undefined) {
		const nextLevel = thinkingLevelValue(value);
		if (!nextLevel || nextLevel === thinkingLevelValue(state?.thinkingLevel)) return;
		if (usingMockHarness) {
			setState((current) => ({...(current ?? {}), thinkingLevel: nextLevel}));
			addActivity(t("admin.agent.mock.thinkingChanged", {level: t(thinkingLevelKeys[nextLevel])}));
			return;
		}
		setSettingsChanging(true);
		setError(undefined);
		try {
			await setPiThinkingLevel(nextLevel);
			applyState(await loadPiState());
			addActivity(
				t("admin.agent.activity.thinkingChanged", {level: t(thinkingLevelKeys[nextLevel])}),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("admin.agent.error.thinking"));
		} finally {
			setSettingsChanging(false);
		}
	}

	async function changeProjectTrust(value: string | undefined) {
		const nextProjectTrust = projectTrustValue(value);
		if (!nextProjectTrust || nextProjectTrust === projectTrust) return;
		if (usingMockHarness) {
			setProjectTrust(nextProjectTrust);
			addActivity(
				t(
					nextProjectTrust === "approve"
						? "admin.agent.mock.trustLoaded"
						: "admin.agent.mock.trustSkipped",
				),
			);
			return;
		}
		setSettingsChanging(true);
		setError(undefined);
		try {
			await setPiProjectTrust(nextProjectTrust);
			setProjectTrust(nextProjectTrust);
			const [nextState, nextCommands, nextModels, nextThinkingLevels] = await Promise.all([
				loadPiState(),
				loadPiCommands(),
				loadPiModels(),
				loadPiThinkingLevels(),
			]);
			applyState(nextState);
			setCommands(nextCommands);
			setModels(nextModels);
			setThinkingLevels(nextThinkingLevels.filter((level) => level !== "off"));
			addActivity(
				t(
					nextProjectTrust === "approve"
						? "admin.agent.activity.trustLoaded"
						: "admin.agent.activity.trustSkipped",
				),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("admin.agent.error.trust"));
		} finally {
			setSettingsChanging(false);
		}
	}

	async function addImage(file: File | undefined) {
		if (!file) return;
		if (!file.type.startsWith("image/")) {
			setError(t("admin.agent.error.imagesOnly"));
			return;
		}
		if (file.size > MAX_IMAGE_BYTES) {
			setError(t("admin.agent.error.imageTooLarge"));
			return;
		}
		try {
			const image = await fileAsImage(file, t("admin.agent.error.imageRead"));
			setImages((current) => [...current, image]);
			setError(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("admin.agent.error.imageAdd"));
		}
	}

	function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
		const imageFromFiles = Array.from(event.clipboardData.files).find((file) =>
			file.type.startsWith("image/"),
		);
		const imageFromItems = Array.from(event.clipboardData.items)
			.find((item) => item.kind === "file" && item.type.startsWith("image/"))
			?.getAsFile();
		const image = imageFromFiles ?? imageFromItems ?? undefined;
		if (!image) return;
		event.preventDefault();
		void addImage(image);
	}

	async function answerExtension(answer: PiExtensionAnswer) {
		setExtension(undefined);
		try {
			await answerPiExtension(answer);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("admin.agent.error.extension"));
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (suggestions.length > 0) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setActiveSuggestion((index) => (index + 1) % suggestions.length);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setActiveSuggestion((index) => (index - 1 + suggestions.length) % suggestions.length);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const suggestion = suggestions[activeSuggestion];
				if (suggestion) selectSuggestion(suggestion);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setCompletionDismissed(true);
				return;
			}
		}
		if (event.key === "Escape" && connection === "working") {
			event.preventDefault();
			void stop();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void submit();
		}
	}

	const model = modelName(state);
	const modelItems = useMemo<SelectItem[]>(
		() => models.map((candidate) => ({value: modelValue(candidate), label: candidate.name})),
		[models],
	);
	const thinkingItems = useMemo<SelectItem[]>(
		() => thinkingLevels.map((level) => ({value: level, label: t(thinkingLevelKeys[level])})),
		[thinkingLevels, t],
	);
	const focusedModelItems = useMemo<PickerItem[]>(
		() => models.map((candidate) => ({value: modelValue(candidate), label: candidate.name})),
		[models],
	);
	const focusedThinkingItems = useMemo<PickerItem[]>(
		() =>
			thinkingLevels.map((level) => ({
				value: level,
				label: t(thinkingLevelKeys[level]),
				icon: thinkingLevelIcons[level],
			})),
		[thinkingLevels, t],
	);
	const selectedModel = selectedModelValue(state) ?? modelItems[0]?.value;
	const stateThinking = thinkingLevelValue(state?.thinkingLevel);
	const selectedThinking =
		stateThinking && stateThinking !== "off" ? stateThinking : (thinkingLevels[0] ?? "minimal");
	const settingsDisabled = disabled || settingsChanging || connection !== "ready";
	const focusedDelivery =
		connection === "working" ? (delivery === "prompt" ? "follow_up" : delivery) : "prompt";
	const focusedMenuItems: MenuItem[] = [
		...(connection === "working"
			? [
					{
						type: "group" as const,
						label: t("admin.agent.menu.streaming"),
						items: [
							{
								type: "radio" as const,
								value: "delivery:steer",
								label: t("admin.agent.delivery.steer"),
								checked: focusedDelivery === "steer",
							},
							{
								type: "radio" as const,
								value: "delivery:follow_up",
								label: t("admin.agent.delivery.followUp"),
								checked: focusedDelivery === "follow_up",
							},
						],
					},
					{type: "separator" as const},
				]
			: []),
		{
			type: "group",
			label: t("admin.agent.menu.projectResources"),
			items: [
				{
					type: "radio",
					value: "trust:approve",
					label: t("admin.agent.trust.load"),
					checked: projectTrust === "approve",
					disabled: settingsDisabled,
				},
				{
					type: "radio",
					value: "trust:no-approve",
					label: t("admin.agent.trust.skip"),
					checked: projectTrust === "no-approve",
					disabled: settingsDisabled,
				},
			],
		},
	];
	const status =
		connection === "loading"
			? t("admin.agent.status.loading")
			: connection === "working"
				? t("admin.agent.status.working")
				: connection === "ready"
					? model
						? t("admin.agent.status.readyWithModel", {model})
						: t("admin.agent.status.ready")
					: t("admin.agent.status.unavailable");

	return (
		<section
			className={`kp-agent-chat kp-agent-chat--${variant}`}
			aria-label={t("admin.agent.label")}
		>
			{variant === "harness" && widget ? <HarnessWidget lines={widget} /> : null}
			<Card className="kp-agent-chat__composer" data-testid="agent-chat-input">
				{variant === "harness" ? (
					<div className="kp-agent-chat__status-row">
						<p className="kp-agent-chat__status" aria-live="polite">
							{status}
							{extensionStatus ? ` · ${extensionStatus}` : ""}
						</p>
						<p className="kp-agent-chat__scope">{t("admin.agent.scope")}</p>
					</div>
				) : null}

				<Form
					className="kp-agent-chat__form"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					{images.length > 0 ? (
						<ul className="kp-agent-chat__attachments" aria-label={t("admin.agent.attachments")}>
							{images.map((image) => (
								<li key={image.name} className="kp-agent-chat__attachment">
									<Icon icon={FileImage} size={16} />
									<span>{image.name}</span>
									<Button
										type="button"
										variant="tertiary"
										size="sm"
										className="kp-agent-chat__attachment-remove"
										onClick={() => setImages((current) => current.filter((item) => item !== image))}
									>
										<Icon icon={X} size={16} />
										<span className="kp-visually-hidden">
											{t("admin.agent.attachment.remove", {name: image.name})}
										</span>
									</Button>
								</li>
							))}
						</ul>
					) : null}

					<div className="kp-agent-chat__field">
						<Textarea
							id={inputId}
							className="kp-agent-chat__textarea"
							label={<span className="kp-visually-hidden">{t("admin.agent.compose.label")}</span>}
							placeholder={t("admin.agent.compose.placeholder")}
							value={draft}
							onChange={(event) => {
								setDraft(event.currentTarget.value);
								setCompletionDismissed(false);
							}}
							onPaste={onPaste}
							onKeyDown={onKeyDown}
							rows={3}
							resize="none"
							spellCheck
							fullWidth
							disabled={disabled}
						/>
						{suggestions.length > 0 ? (
							<Card
								className="kp-agent-chat__suggestions"
								role="listbox"
								aria-label={t("admin.agent.completions")}
							>
								{suggestions.map((suggestion, index) => (
									<SuggestionRow
										key={suggestion.kind === "command" ? suggestion.command.name : suggestion.path}
										suggestion={suggestion}
										active={index === activeSuggestion}
										onSelect={() => selectSuggestion(suggestion)}
									/>
								))}
							</Card>
						) : null}
					</div>

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
									<Button
										type="button"
										variant="tertiary"
										size="sm"
										className="kp-agent-chat__icon-button"
										aria-label={t("admin.agent.image.add")}
										onClick={() => imageInputRef.current?.click()}
										disabled={disabled}
									>
										<Icon icon={Paperclip} size={16} />
									</Button>
								</>
							) : null}
							<fieldset className="kp-agent-chat__settings">
								<legend className="kp-visually-hidden">{t("admin.agent.settings")}</legend>
								{variant === "focused" ? (
									<>
										<SettingMenu
											label={t("admin.agent.setting.model")}
											items={focusedModelItems}
											value={selectedModel}
											onValueChange={(value) => void changeModel(value)}
											disabled={settingsDisabled || focusedModelItems.length < 2}
										/>
										<SettingMenu
											label={t("admin.agent.setting.thinking")}
											items={focusedThinkingItems}
											value={selectedThinking}
											onValueChange={(value) => void changeThinkingLevel(value)}
											disabled={settingsDisabled || focusedThinkingItems.length < 2}
										/>
									</>
								) : (
									<>
										<div className="kp-agent-chat__setting">
											<Icon icon={Bot} size={14} />
											<Select
												className="kp-agent-chat__setting-select kp-agent-chat__setting-select--model"
												label={
													<span className="kp-visually-hidden">
														{t("admin.agent.select.model")}
													</span>
												}
												items={modelItems}
												value={selectedModel ? [selectedModel] : []}
												onValueChange={(values) => void changeModel(values[0])}
												placement="top-start"
												size="sm"
												disabled={settingsDisabled || modelItems.length < 2}
											/>
										</div>
										<div className="kp-agent-chat__setting">
											<Icon icon={Brain} size={14} />
											<Select
												className="kp-agent-chat__setting-select"
												label={
													<span className="kp-visually-hidden">
														{t("admin.agent.select.thinking")}
													</span>
												}
												items={thinkingItems}
												value={[selectedThinking]}
												onValueChange={(values) => void changeThinkingLevel(values[0])}
												placement="top-start"
												size="sm"
												disabled={settingsDisabled || thinkingItems.length < 2}
											/>
										</div>
										<div className="kp-agent-chat__setting">
											<Icon icon={ShieldCheck} size={14} />
											<Select
												className="kp-agent-chat__setting-select"
												label={
													<span className="kp-visually-hidden">
														{t("admin.agent.select.trust")}
													</span>
												}
												items={toItems(projectTrustKeys, t)}
												value={[projectTrust]}
												onValueChange={(values) => void changeProjectTrust(values[0])}
												placement="top-start"
												size="sm"
												disabled={settingsDisabled}
											/>
										</div>
									</>
								)}
							</fieldset>
							{variant === "focused" ? (
								<Menu
									placement="top-start"
									ariaLabel={t("admin.agent.settings")}
									trigger={
										<Button
											type="button"
											variant="tertiary"
											size="sm"
											className="kp-agent-chat__resources-button"
											aria-label={t("admin.agent.resources.label")}
										>
											<Icon icon={ShieldCheck} size={14} />
											{t("admin.agent.resources")}
										</Button>
									}
									items={focusedMenuItems}
									onSelect={(value) => {
										if (value === "delivery:steer") setDelivery("steer");
										if (value === "delivery:follow_up") setDelivery("follow_up");
										if (value === "trust:approve") void changeProjectTrust("approve");
										if (value === "trust:no-approve") void changeProjectTrust("no-approve");
									}}
								/>
							) : null}
						</div>
						<div className="kp-agent-chat__send-controls">
							{variant === "harness" ? (
								<Select
									className="kp-agent-chat__delivery"
									label={
										<span className="kp-visually-hidden">{t("admin.agent.select.delivery")}</span>
									}
									items={toItems(deliveryModeKeys, t)}
									value={[delivery]}
									onValueChange={(values) => {
										const nextDelivery = deliveryMode(values[0]);
										if (nextDelivery) setDelivery(nextDelivery);
									}}
									placement="top-end"
									size="sm"
								/>
							) : null}
							{connection === "working" ? (
								<Button type="button" variant="tertiary" size="sm" onClick={() => void stop()}>
									<Icon icon={Square} size={16} /> {t("admin.agent.stop")}
								</Button>
							) : null}
							<Button
								type="submit"
								variant="primary"
								size="sm"
								disabled={disabled || connection === "loading" || connection === "unavailable"}
							>
								{t(
									variant === "focused" && connection === "working"
										? focusedDelivery === "steer"
											? "admin.agent.delivery.steer"
											: "admin.agent.delivery.followUp"
										: connection === "working"
											? "admin.agent.queue"
											: "admin.agent.send",
								)}{" "}
								<Icon icon={SendHorizontal} size={16} />
							</Button>
						</div>
					</div>
				</Form>

				{variant === "harness" ? (
					<p className="kp-agent-chat__hint">
						<Kbd>Enter</Kbd> {t("admin.agent.hint.send")} · <Kbd>Shift+Enter</Kbd>{" "}
						{t("admin.agent.hint.newline")} · <Kbd>/</Kbd> {t("admin.agent.hint.command")} ·{" "}
						<Kbd>@</Kbd> {t("admin.agent.hint.file")} · {t("admin.agent.hint.pasteImage")}
					</p>
				) : (
					<p className="kp-agent-chat__hint">
						<Kbd>/</Kbd> {t("admin.agent.hint.command")} · <Kbd>@</Kbd> {t("admin.agent.hint.file")}{" "}
						· {t("admin.agent.hint.addOrPasteImage")}
					</p>
				)}
				{error ? (
					<Alert className="kp-agent-chat__error" variant="danger">
						{error}
					</Alert>
				) : null}
			</Card>

			{variant === "focused" ? (
				<Collapsible
					className="kp-agent-chat__inspector"
					open={inspectorOpen}
					onOpenChange={setInspectorOpen}
					indicator={false}
					trigger={
						<span className="kp-agent-chat__inspector-trigger">
							<span className="kp-agent-chat__inspector-title">
								{t("admin.agent.inspector")}
								{activities.length > 0 ? <span>{activities.length}</span> : null}
							</span>
							<Icon icon={inspectorOpen ? ChevronUp : ChevronDown} size={16} />
						</span>
					}
				>
					<div className="kp-agent-chat__inspector-content">
						{widget ? <HarnessWidget lines={widget} /> : null}
						<AgentActivity assistantText={assistantText} activities={activities} />
					</div>
				</Collapsible>
			) : (
				<AgentActivity assistantText={assistantText} activities={activities} />
			)}
			{extension ? <PiExtensionDialog request={extension} onAnswer={answerExtension} /> : null}
		</section>
	);
}

function SettingMenu({
	label,
	items,
	value,
	onValueChange,
	disabled,
}: {
	readonly label: string;
	readonly items: readonly PickerItem[];
	readonly value?: string;
	readonly onValueChange: (value: string) => void;
	readonly disabled?: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const selected = items.find((item) => item.value === value);
	return (
		<Menu
			open={open}
			onOpenChange={setOpen}
			placement="top-start"
			ariaLabel={label}
			className="kp-agent-chat__picker-menu"
			trigger={
				<Button
					type="button"
					variant="tertiary"
					size="sm"
					className="kp-agent-chat__picker-trigger"
					aria-label={`${label}: ${selected?.label ?? t("admin.agent.picker.loading")}`}
					disabled={disabled}
				>
					{selected?.icon ? <Icon icon={selected.icon} size={14} /> : null}
					<span>{selected?.label ?? "…"}</span>
					<Icon icon={open ? ChevronUp : ChevronDown} size={14} />
				</Button>
			}
			items={[
				{
					type: "group",
					label,
					items: items.map((item) => ({
						type: "radio",
						value: item.value,
						label: item.label,
						checked: item.value === value,
						...(item.icon ? {icon: <Icon icon={item.icon} size={16} />} : {}),
					})),
				},
			]}
			onSelect={(nextValue) => {
				onValueChange(nextValue);
				setOpen(false);
			}}
		/>
	);
}

function SuggestionRow({
	suggestion,
	active,
	onSelect,
}: {
	readonly suggestion: Suggestion;
	readonly active: boolean;
	readonly onSelect: () => void;
}) {
	const command = suggestion.kind === "command" ? suggestion.command : undefined;
	return (
		<Button
			type="button"
			variant="tertiary"
			block
			className="kp-agent-chat__suggestion"
			role="option"
			aria-selected={active}
			onClick={onSelect}
		>
			<Icon icon={suggestion.kind === "command" ? Terminal : FileIcon} size={16} />
			<span className="kp-agent-chat__suggestion-main">
				{suggestion.kind === "command" ? `/${command?.name ?? ""}` : `@${suggestion.path}`}
			</span>
			{command?.description ? (
				<span className="kp-agent-chat__suggestion-detail">{command.description}</span>
			) : null}
		</Button>
	);
}

function HarnessWidget({lines}: {readonly lines: readonly string[]}) {
	const t = useT();
	return (
		<Card className="kp-agent-chat__widget" role="status">
			<p className="kp-agent-chat__widget-title">{t("admin.agent.extension.title")}</p>
			<pre>{lines.join("\n")}</pre>
		</Card>
	);
}

function AgentActivity({
	assistantText,
	activities,
}: {
	readonly assistantText: string;
	readonly activities: readonly Activity[];
}) {
	const t = useT();
	return (
		<Card className="kp-agent-chat__activity" aria-live="polite">
			<p className="kp-agent-chat__activity-title">{t("admin.agent.activity.title")}</p>
			{assistantText ? (
				<pre className="kp-agent-chat__assistant-text">{assistantText}</pre>
			) : (
				<p className="kp-agent-chat__empty">{t("admin.agent.activity.empty")}</p>
			)}
			{activities.length > 0 ? (
				<ul className="kp-agent-chat__activity-list">
					{activities.map((activity) => (
						<li key={activity.id}>{activity.text}</li>
					))}
				</ul>
			) : null}
		</Card>
	);
}

function PiExtensionDialog({
	request,
	onAnswer,
}: {
	readonly request: ExtensionRequest;
	readonly onAnswer: (answer: PiExtensionAnswer) => Promise<void>;
}) {
	const t = useT();
	const [value, setValue] = useState(request.prefill ?? "");
	useEffect(() => setValue(request.prefill ?? ""), [request.id, request.prefill]);
	const cancel = () => void onAnswer({id: request.id, cancelled: true});
	const answer = (next: Omit<PiExtensionAnswer, "id">) => void onAnswer({id: request.id, ...next});
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) cancel();
			}}
			title={request.title}
			{...(request.message ? {description: request.message} : {})}
			footer={() =>
				request.method === "confirm" ? (
					<>
						<Button variant="tertiary" onClick={cancel}>
							{t("admin.agent.extension.cancel")}
						</Button>
						<Button variant="primary" onClick={() => answer({confirmed: true})}>
							{t("admin.agent.extension.confirm")}
						</Button>
					</>
				) : request.method === "select" ? (
					<Button variant="tertiary" onClick={cancel}>
						{t("admin.agent.extension.cancel")}
					</Button>
				) : (
					<>
						<Button variant="tertiary" onClick={cancel}>
							{t("admin.agent.extension.cancel")}
						</Button>
						<Button variant="primary" onClick={() => answer({value})}>
							{t("admin.agent.extension.submit")}
						</Button>
					</>
				)
			}
		>
			{request.method === "select" ? (
				<div className="kp-agent-chat__extension-options">
					{request.options?.map((option) => (
						<Button key={option} variant="secondary" block onClick={() => answer({value: option})}>
							{option}
						</Button>
					))}
				</div>
			) : request.method === "input" ? (
				<Input
					label={<span className="kp-visually-hidden">{t("admin.agent.extension.input")}</span>}
					placeholder={request.placeholder}
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
					fullWidth
				/>
			) : request.method === "editor" ? (
				<Textarea
					label={<span className="kp-visually-hidden">{t("admin.agent.extension.editor")}</span>}
					placeholder={request.placeholder}
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
					rows={8}
					resize="vertical"
					fullWidth
				/>
			) : null}
		</Dialog>
	);
}
