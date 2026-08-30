import {
	AtSign,
	Bot,
	Brain,
	ChevronDown,
	ChevronsDown,
	ChevronsUp,
	ChevronUp,
	CircleOff,
	FileImage,
	type LucideIcon,
	Minus,
	Paperclip,
	SendHorizontal,
	ShieldCheck,
	Slash,
	Sparkles,
	Square,
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

const deliveryModes: SelectItem[] = [
	{value: "prompt", label: "gönder"},
	{value: "steer", label: "yönlendir"},
	{value: "follow_up", label: "sonraya al"},
];

const projectTrustModes: SelectItem[] = [
	{value: "approve", label: "güven"},
	{value: "no-approve", label: "yoksay"},
];

const thinkingLevelLabels: Readonly<Record<PiThinkingLevel, string>> = {
	off: "kapalı",
	minimal: "minimal",
	low: "düşük",
	medium: "orta",
	high: "yüksek",
	xhigh: "çok yüksek",
	max: "maksimum",
};

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

const mockCommands: readonly PiCommand[] = [
	{name: "review", description: "Değişiklikleri gözden geçir."},
	{name: "compact", description: "Oturum bağlamını sıkıştır."},
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

function extensionRequest(event: PiEvent): ExtensionRequest | undefined {
	if (event.type !== "extension_ui_request") return undefined;
	const id = stringValue(event, "id");
	const rawMethod = stringValue(event, "method");
	const title = stringValue(event, "title") ?? "Pi eklentisi";
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

function fileAsImage(file: File): Promise<PiImage> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("Görsel okunamadı."));
		reader.onload = () => {
			if (typeof reader.result !== "string") {
				reject(new Error("Görsel okunamadı."));
				return;
			}
			const data = reader.result.split(",", 2)[1];
			if (!data) {
				reject(new Error("Görsel okunamadı."));
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
			setCommands(mockCommands);
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
				setError(cause instanceof Error ? cause.message : "Pi harness'a bağlanılamadı.");
			});
		return () => {
			current = false;
			unsubscribe();
		};
	}, [mockWhenUnavailable]);

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
			addActivity("Pi çalışmaya başladı.");
			return;
		}
		if (event.type === "agent_settled") {
			setConnection("ready");
			addActivity("Pi turu tamamlandı.");
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
			const tool = stringValue(event, "toolName") ?? "araç";
			addActivity(`Pi ${tool} kullanıyor.`);
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
		const request = extensionRequest(event);
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
			addActivity("Deploy preview istemi mock harness'a gönderildi.");
			setAssistantText("Bu, Agent Chat Input görünümünü denemek için üretilen mock yanıttır.");
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
				message: message || "Bu görseli incele.",
				...(images.length > 0 ? {images} : {}),
				...(streamedPrompt ? {streamingBehavior: "steer"} : {}),
			});
			addActivity(
				streamedPrompt
					? "İstem, çalışan tur için yönlendirme olarak kuyruğa alındı."
					: requestedDelivery === "prompt"
						? "İstem Pi'ye gönderildi."
						: requestedDelivery === "steer"
							? "Yönlendirme Pi kuyruğuna alındı."
							: "Sonraki istem Pi kuyruğuna alındı.",
			);
			setDraft("");
			setImages([]);
			setAssistantText("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "İstem gönderilemedi.");
		}
	}

	async function stop() {
		if (usingMockHarness) {
			setConnection("ready");
			addActivity("Mock tur durduruldu.");
			return;
		}
		try {
			await abortPi();
			addActivity("Pi durdurma isteğini aldı.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Pi durdurulamadı.");
		}
	}

	async function changeModel(value: string | undefined) {
		const nextModel = models.find((model) => modelValue(model) === value);
		if (!nextModel || value === selectedModelValue(state)) return;
		if (usingMockHarness) {
			setState((current) => ({...(current ?? {}), model: nextModel}));
			addActivity(`Mock Pi modeli ${nextModel.name} olarak değiştirildi.`);
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
			addActivity(`Pi modeli ${nextModel.name} olarak değiştirildi.`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Pi modeli değiştirilemedi.");
		} finally {
			setSettingsChanging(false);
		}
	}

	async function changeThinkingLevel(value: string | undefined) {
		const nextLevel = thinkingLevelValue(value);
		if (!nextLevel || nextLevel === thinkingLevelValue(state?.thinkingLevel)) return;
		if (usingMockHarness) {
			setState((current) => ({...(current ?? {}), thinkingLevel: nextLevel}));
			addActivity(`Mock düşünme eforu ${thinkingLevelLabels[nextLevel]} olarak değiştirildi.`);
			return;
		}
		setSettingsChanging(true);
		setError(undefined);
		try {
			await setPiThinkingLevel(nextLevel);
			applyState(await loadPiState());
			addActivity(`Pi düşünme eforu ${thinkingLevelLabels[nextLevel]} olarak değiştirildi.`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Pi düşünme eforu değiştirilemedi.");
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
				nextProjectTrust === "approve"
					? "Mock proje kaynakları yüklendi."
					: "Mock proje kaynakları yoksayıldı.",
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
				nextProjectTrust === "approve"
					? "Pi proje kaynaklarını yükleyecek şekilde yeniden başlatıldı."
					: "Pi proje kaynaklarını yoksayacak şekilde yeniden başlatıldı.",
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Pi proje izni değiştirilemedi.");
		} finally {
			setSettingsChanging(false);
		}
	}

	async function addImage(file: File | undefined) {
		if (!file) return;
		if (!file.type.startsWith("image/")) {
			setError("Pi RPC prototipi yalnızca görsel eklerini kabul ediyor.");
			return;
		}
		if (file.size > MAX_IMAGE_BYTES) {
			setError("Görsel 5 MB'dan küçük olmalı.");
			return;
		}
		try {
			const image = await fileAsImage(file);
			setImages((current) => [...current, image]);
			setError(undefined);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Görsel eklenemedi.");
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
			setError(cause instanceof Error ? cause.message : "Pi eklentisine yanıt verilemedi.");
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
		() => thinkingLevels.map((level) => ({value: level, label: thinkingLevelLabels[level]})),
		[thinkingLevels],
	);
	const focusedModelItems = useMemo<PickerItem[]>(
		() => models.map((candidate) => ({value: modelValue(candidate), label: candidate.name})),
		[models],
	);
	const focusedThinkingItems = useMemo<PickerItem[]>(
		() =>
			thinkingLevels.map((level) => ({
				value: level,
				label: thinkingLevelLabels[level],
				icon: thinkingLevelIcons[level],
			})),
		[thinkingLevels],
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
						label: "çalışırken gönderme",
						items: [
							{
								type: "radio" as const,
								value: "delivery:steer",
								label: "yönlendir",
								checked: focusedDelivery === "steer",
							},
							{
								type: "radio" as const,
								value: "delivery:follow_up",
								label: "sonraya al",
								checked: focusedDelivery === "follow_up",
							},
						],
					},
					{type: "separator" as const},
				]
			: []),
		{
			type: "group",
			label: "proje kaynakları",
			items: [
				{
					type: "radio",
					value: "trust:approve",
					label: "kaynakları yükle",
					checked: projectTrust === "approve",
					disabled: settingsDisabled,
				},
				{
					type: "radio",
					value: "trust:no-approve",
					label: "kaynakları yükleme",
					checked: projectTrust === "no-approve",
					disabled: settingsDisabled,
				},
			],
		},
	];
	const status =
		connection === "loading"
			? "Pi aranıyor…"
			: connection === "working"
				? "Pi çalışıyor"
				: connection === "ready"
					? model
						? `Pi hazır · ${model}`
						: "Pi hazır"
					: "Pi yerelde kullanılamıyor";

	return (
		<section className={`kp-agent-chat kp-agent-chat--${variant}`} aria-label="Agent chat input">
			{variant === "harness" && widget ? <HarnessWidget lines={widget} /> : null}
			<Card className="kp-agent-chat__composer" data-testid="agent-chat-input">
				{variant === "harness" ? (
					<div className="kp-agent-chat__status-row">
						<p className="kp-agent-chat__status" aria-live="polite">
							{status}
							{extensionStatus ? ` · ${extensionStatus}` : ""}
						</p>
						<p className="kp-agent-chat__scope">yalnızca yerel atölye</p>
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
						<ul className="kp-agent-chat__attachments" aria-label="Görsel ekleri">
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
										<span className="kp-visually-hidden">{image.name} görselini kaldır</span>
									</Button>
								</li>
							))}
						</ul>
					) : null}

					<div className="kp-agent-chat__field">
						<Textarea
							id={inputId}
							className="kp-agent-chat__textarea"
							label={<span className="kp-visually-hidden">Pi'ye mesaj yaz</span>}
							placeholder="Pi'ye ne yapmak istediğini söyle…"
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
								aria-label="Pi tamamlamaları"
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
									<input
										ref={imageInputRef}
										className="kp-visually-hidden"
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
										aria-label="Görsel ekle"
										onClick={() => imageInputRef.current?.click()}
										disabled={disabled}
									>
										<Icon icon={Paperclip} size={16} />
									</Button>
								</>
							) : null}
							<fieldset className="kp-agent-chat__settings">
								<legend className="kp-visually-hidden">Pi ayarları</legend>
								{variant === "focused" ? (
									<>
										<SettingMenu
											label="model"
											items={focusedModelItems}
											value={selectedModel}
											onValueChange={(value) => void changeModel(value)}
											disabled={settingsDisabled || focusedModelItems.length < 2}
										/>
										<SettingMenu
											label="düşünme eforu"
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
												label={<span className="kp-visually-hidden">Pi modeli</span>}
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
												label={<span className="kp-visually-hidden">Pi düşünme eforu</span>}
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
														Pi proje izni. Güven, yerel proje kaynaklarını yükler; yoksay bunları
														devre dışı bırakır.
													</span>
												}
												items={projectTrustModes}
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
									ariaLabel="Pi ayarları"
									trigger={
										<Button
											type="button"
											variant="tertiary"
											size="sm"
											className="kp-agent-chat__resources-button"
											aria-label="Proje kaynakları ve gönderme ayarları"
										>
											<Icon icon={ShieldCheck} size={14} />
											kaynaklar
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
									label={<span className="kp-visually-hidden">Pi teslim modu</span>}
									items={deliveryModes}
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
									<Icon icon={Square} size={16} /> durdur
								</Button>
							) : null}
							<Button
								type="submit"
								variant="primary"
								size="sm"
								disabled={disabled || connection === "loading" || connection === "unavailable"}
							>
								{variant === "focused" && connection === "working"
									? focusedDelivery === "steer"
										? "yönlendir"
										: "sonraya al"
									: connection === "working"
										? "kuyruğa al"
										: "gönder"}{" "}
								<Icon icon={SendHorizontal} size={16} />
							</Button>
						</div>
					</div>
				</Form>

				{variant === "harness" ? (
					<p className="kp-agent-chat__hint">
						<Kbd>Enter</Kbd> gönder · <Kbd>Shift+Enter</Kbd> satır ekle · <Kbd>/</Kbd> komut ·{" "}
						<Kbd>@</Kbd> dosya · görseli yapıştır
					</p>
				) : (
					<p className="kp-agent-chat__hint">
						<Kbd>/</Kbd> komut · <Kbd>@</Kbd> dosya · görsel ekle veya yapıştır
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
								Pi denetçisi
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
					aria-label={`${label}: ${selected?.label ?? "yükleniyor"}`}
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
			<Icon icon={suggestion.kind === "command" ? Slash : AtSign} size={16} />
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
	return (
		<Card className="kp-agent-chat__widget" role="status">
			<p className="kp-agent-chat__widget-title">Pi eklentisi</p>
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
	return (
		<Card className="kp-agent-chat__activity" aria-live="polite">
			<p className="kp-agent-chat__activity-title">harness etkinliği</p>
			{assistantText ? (
				<pre className="kp-agent-chat__assistant-text">{assistantText}</pre>
			) : (
				<p className="kp-agent-chat__empty">Pi yanıtı ve araç etkinlikleri burada görünür.</p>
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
							vazgeç
						</Button>
						<Button variant="primary" onClick={() => answer({confirmed: true})}>
							onayla
						</Button>
					</>
				) : request.method === "select" ? (
					<Button variant="tertiary" onClick={cancel}>
						vazgeç
					</Button>
				) : (
					<>
						<Button variant="tertiary" onClick={cancel}>
							vazgeç
						</Button>
						<Button variant="primary" onClick={() => answer({value})}>
							gönder
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
					label={<span className="kp-visually-hidden">Pi eklentisi yanıtı</span>}
					placeholder={request.placeholder}
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
					fullWidth
				/>
			) : request.method === "editor" ? (
				<Textarea
					label={<span className="kp-visually-hidden">Pi eklentisi metni</span>}
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
