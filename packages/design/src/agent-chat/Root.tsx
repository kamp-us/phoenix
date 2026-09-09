import {
	type ClipboardEvent,
	createContext,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useContext,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	AgentChatInputBridge,
	PiCommand,
	PiDeliveryMode,
	PiEvent,
	PiExtensionAnswer,
	PiImage,
	PiModel,
	PiProjectTrust,
	PiThinkingLevel,
} from "../agent-chat-bridge";
import {useDesignT} from "../i18n";
import {thinkingLevelKeys} from "./catalog";
import {
	type AgentChatDeliveryRule,
	deliveryRuleForVariant,
	requestedDelivery as resolveRequestedDelivery,
} from "./delivery";
import {fileAsImage, MAX_IMAGE_BYTES} from "./image";
import {mockCommands, mockFiles, mockModels, mockThinkingLevels} from "./mock-harness";
import {
	assistantMessageText,
	booleanValue,
	commandList,
	completionFor,
	extensionRequest,
	isRecord,
	modelList,
	modelValue,
	projectTrustValue,
	selectedModelValue,
	stringValue,
	thinkingLevelList,
	thinkingLevelValue,
} from "./parse";
import type {Activity, ConnectionState, ExtensionRequest, Suggestion} from "./types";
import {unavailableBridge} from "./unavailable-bridge";

export interface AgentChatInputProps {
	readonly bridge?: AgentChatInputBridge;
	readonly initialValue?: string;
	readonly disabled?: boolean;
	/**
	 * Styling only. It picks the composer's border, layout and which controls sit behind the
	 * disclosure; `deliveryRule` decides how a send goes out. #8669 retires this prop.
	 */
	readonly variant?: "harness" | "focused";
	/**
	 * How a send is delivered.
	 *
	 * - `as-picked` — send exactly what the delivery picker holds, whatever the harness is doing.
	 * - `queue-while-working` — the picker only applies while the harness is working, and a `prompt`
	 *   picked there queues as a `follow_up` instead of interrupting the run. A send at any other
	 *   connection state is always a fresh `prompt`.
	 *
	 * Unset, it is derived from `variant` — `focused` means `queue-while-working`, `harness` means
	 * `as-picked` — so a host that never named it keeps the delivery it has today.
	 */
	readonly deliveryRule?: AgentChatDeliveryRule;
	readonly mockWhenUnavailable?: boolean;
	/**
	 * Called with the composer's text whenever an edit changes it — a keystroke, an accepted
	 * completion, an extension's `set_editor_text`, or the clear a successful send performs. For a
	 * consumer that persists the draft somewhere of its own; the component still owns the value.
	 */
	readonly onDraftChange?: (draft: string) => void;
	/**
	 * A host's own settings controls, rendered inside the settings fieldset after the ones this
	 * component owns. It is a slot rather than another bridge method because what belongs here is
	 * per-host vocabulary the bridge has no words for — Tuval's agent mode is the first — and a
	 * bridge method would make every implementor answer a question only one of them has.
	 *
	 * Build the control out of `AgentSettingMenu` so it reads as one row with the model and thinking
	 * pickers rather than as a foreign control wedged beside them.
	 */
	readonly settings?: ReactNode;
	/**
	 * The prompt field itself, for a host that has to place DOM focus on it — the composer is the
	 * only control here a host can be asked to focus, so the ref is the field and not a handle.
	 */
	readonly ref?: Ref<HTMLTextAreaElement>;
}

/**
 * What Root provides and every composer part reads. Root owns the bridge and the draft; a part is
 * then a component that reads this and returns markup, which is what makes it movable.
 */
export interface AgentChatInputState {
	readonly disabled: boolean;
	readonly variant: "harness" | "focused";
	readonly deliveryRule: AgentChatDeliveryRule;
	readonly settings: ReactNode;
	readonly fieldRef: Ref<HTMLTextAreaElement> | undefined;
	readonly inputId: string;
	readonly suggestionsId: string;
	readonly draft: string;
	readonly delivery: PiDeliveryMode;
	readonly connection: ConnectionState;
	readonly harnessState: Record<string, unknown> | undefined;
	readonly commands: readonly PiCommand[];
	readonly models: readonly PiModel[] | undefined;
	readonly thinkingLevels: readonly PiThinkingLevel[] | undefined;
	readonly projectTrust: PiProjectTrust;
	readonly settingsChanging: boolean;
	/** Whether a settings control may be operated: read by the fieldset and by the overflow menu. */
	readonly settingsDisabled: boolean;
	readonly images: readonly PiImage[];
	readonly error: string | undefined;
	readonly assistantText: string;
	readonly activities: readonly Activity[];
	readonly suggestions: readonly Suggestion[];
	readonly activeSuggestion: number;
	readonly activeSuggestionId: string | undefined;
	readonly extension: ExtensionRequest | undefined;
	readonly extensionStatus: string | undefined;
	readonly widget: readonly string[] | undefined;
	readonly inspectorOpen: boolean;
}

/**
 * What a part can ask Root to do. Held apart from the state above only so Root can publish one
 * identity for the whole set: every entry closes over the current render's state, so rebuilding
 * the object each render would make the context value change on every keystroke for parts that
 * read nothing but these.
 */
export interface AgentChatInputActions {
	readonly setInspectorOpen: (open: boolean) => void;
	readonly setDelivery: (delivery: PiDeliveryMode) => void;
	/** An edit made in the field: it notifies the consumer and re-opens a dismissed completion. */
	readonly typeDraft: (value: string) => void;
	readonly selectSuggestion: (suggestion: Suggestion) => void;
	readonly removeImage: (image: PiImage) => void;
	readonly addImage: (file: File | undefined) => Promise<void>;
	readonly submit: () => Promise<void>;
	readonly stop: () => Promise<void>;
	readonly changeModel: (value: string | undefined) => Promise<void>;
	readonly changeThinkingLevel: (value: string | undefined) => Promise<void>;
	readonly changeProjectTrust: (value: string | undefined) => Promise<void>;
	readonly answerExtension: (answer: PiExtensionAnswer) => Promise<void>;
	readonly onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
	readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export interface AgentChatInputContextValue extends AgentChatInputState, AgentChatInputActions {}

const AgentChatInputContext = createContext<AgentChatInputContextValue | undefined>(undefined);

export function useAgentChatInput(): AgentChatInputContextValue {
	const value = useContext(AgentChatInputContext);
	if (!value) {
		throw new Error("AgentChatInput parts must be rendered inside <AgentChatInput.Root>.");
	}
	return value;
}

export function AgentChatInputRoot({
	bridge,
	initialValue = "",
	disabled = false,
	variant = "harness",
	deliveryRule,
	mockWhenUnavailable = false,
	onDraftChange,
	settings,
	ref,
	children,
}: AgentChatInputProps & {readonly children: ReactNode}) {
	const activeBridge = bridge ?? unavailableBridge;
	const rule = deliveryRule ?? deliveryRuleForVariant(variant);
	const t = useDesignT();
	const inputId = useId();
	const suggestionsId = `${inputId}-suggestions`;
	const [draft, setDraft] = useState(initialValue);
	const [delivery, setDelivery] = useState<PiDeliveryMode>("prompt");
	const [connection, setConnection] = useState<ConnectionState>("loading");
	const [state, setState] = useState<Record<string, unknown>>();
	const [commands, setCommands] = useState<readonly PiCommand[]>([]);
	// `undefined` until the host answers, and an answer of `[]` is a real one: a harness that offers
	// no models or no thinking levels is not a harness still loading them (#8425).
	const [models, setModels] = useState<readonly PiModel[]>();
	const [thinkingLevels, setThinkingLevels] = useState<readonly PiThinkingLevel[]>();
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

	// Only edits notify. The `initialValue` sync above is the consumer's own write coming back, and
	// echoing it would loop a consumer that feeds `onDraftChange` into `initialValue`.
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const editDraft = (next: string | ((current: string) => string)) => {
		const value = typeof next === "function" ? next(draftRef.current) : next;
		setDraft(value);
		onDraftChange?.(value);
	};

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
		void Promise.all([
			activeBridge.loadPiState(),
			activeBridge.loadPiCommands(),
			activeBridge.loadPiModels(),
			activeBridge.loadPiThinkingLevels(),
		])
			.then(([nextState, nextCommands, nextModels, nextThinkingLevels]) => {
				if (!current) return;
				const selectableThinkingLevels = nextThinkingLevels?.filter((level) => level !== "off");
				if (
					mockWhenUnavailable &&
					((nextModels?.length ?? 0) === 0 || (selectableThinkingLevels?.length ?? 0) === 0)
				) {
					applyMockHarness();
					return;
				}
				applyState(nextState);
				setCommands(nextCommands);
				setModels(nextModels);
				setThinkingLevels(selectableThinkingLevels);
				unsubscribe = activeBridge.subscribeToPiEvents(
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
	}, [activeBridge, mockWhenUnavailable, t]);

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
			void activeBridge
				.loadPiFiles(completion.query)
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
	}, [activeBridge, completion, completionDismissed, usingMockHarness]);

	const suggestions = useMemo<readonly Suggestion[]>(() => {
		if (!completion || completionDismissed) return [];
		if (completion.kind === "file") return files.map((path) => ({kind: "file", path}));
		const query = completion.query.toLocaleLowerCase();
		return commands
			.filter((command) => command.name.toLocaleLowerCase().includes(query))
			.slice(0, 8)
			.map((command) => ({kind: "command", command}));
	}, [commands, completion, completionDismissed, files]);
	const activeSuggestionId =
		suggestions.length > 0 ? `${suggestionsId}-${activeSuggestion}` : undefined;
	const settingsDisabled = disabled || settingsChanging || connection !== "ready";

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
			// A harness whose catalog is not known at mount pushes it here. The four loads run once
			// per bridge identity, so a host that only learns its models after connecting has no
			// other way in that does not restart the whole composer.
			const nextModels = status && modelList(status.models);
			if (nextModels) setModels(nextModels);
			// Replaced, never merged: a host pushes its whole command list, so a merge would keep one
			// it has just withdrawn.
			const nextCommands = status && commandList(status.commands);
			if (nextCommands) setCommands(nextCommands);
			const nextModel = status && isRecord(status.model) ? status.model : undefined;
			if (nextModel) setState((current) => ({...(current ?? {}), model: nextModel}));
			// The thinking picker takes the same route for the same reason: a harness that only
			// learns its per-model level set after connecting would otherwise leave a live picker
			// over no rows (#8062).
			const nextLevels = status && thinkingLevelList(status.thinkingLevels);
			if (nextLevels) {
				setThinkingLevels(nextLevels);
				// A level the session has stopped offering is not the level it is running on. Left
				// standing it reads as an operator selection the backend would refuse — and on the
				// harness variant it kept rendering as the trigger's own label (#8425).
				setState((current) => {
					const held = thinkingLevelValue(current?.thinkingLevel);
					if (held === undefined || nextLevels.includes(held)) return current;
					const {thinkingLevel: _dropped, ...rest} = current ?? {};
					return rest;
				});
			}
			const nextLevel = status && thinkingLevelValue(status.thinkingLevel);
			if (nextLevel) setState((current) => ({...(current ?? {}), thinkingLevel: nextLevel}));
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
			if (text !== undefined) editDraft(text);
			return;
		}
		if (method === "setTitle") {
			const title = stringValue(event, "title");
			if (title) document.title = title;
		}
	}

	function typeDraft(value: string) {
		editDraft(value);
		setCompletionDismissed(false);
	}

	function selectSuggestion(suggestion: Suggestion) {
		if (!completion) return;
		const replacement =
			suggestion.kind === "command" ? `/${suggestion.command.name}` : `@${suggestion.path}`;
		editDraft(
			(current) =>
				`${current.slice(0, completion.start)}${replacement} ${current.slice(completion.end)}`,
		);
		setCompletionDismissed(true);
	}

	function removeImage(image: PiImage) {
		setImages((current) => current.filter((item) => item !== image));
	}

	async function submit() {
		const message = draft.trim();
		if ((!message && images.length === 0) || disabled || connection === "unavailable") return;
		setError(undefined);
		if (usingMockHarness) {
			addActivity(t("admin.agent.mock.prompted"));
			setAssistantText(t("admin.agent.mock.reply"));
			editDraft("");
			setImages([]);
			return;
		}
		try {
			const requestedDelivery = resolveRequestedDelivery(rule, connection, delivery);
			const streamedPrompt = connection === "working" && requestedDelivery === "prompt";
			await activeBridge.sendPiPrompt({
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
			editDraft("");
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
			await activeBridge.abortPi();
			addActivity(t("admin.agent.activity.stopped"));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("admin.agent.error.stop"));
		}
	}

	async function changeModel(value: string | undefined) {
		const nextModel = models?.find((model) => modelValue(model) === value);
		if (!nextModel || value === selectedModelValue(state)) return;
		if (usingMockHarness) {
			setState((current) => ({...(current ?? {}), model: nextModel}));
			addActivity(t("admin.agent.mock.modelChanged", {model: nextModel.name}));
			return;
		}
		setSettingsChanging(true);
		setError(undefined);
		try {
			await activeBridge.setPiModel(nextModel);
			const [nextState, nextThinkingLevels] = await Promise.all([
				activeBridge.loadPiState(),
				activeBridge.loadPiThinkingLevels(),
			]);
			applyState(nextState);
			setThinkingLevels(nextThinkingLevels?.filter((level) => level !== "off"));
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
			await activeBridge.setPiThinkingLevel(nextLevel);
			applyState(await activeBridge.loadPiState());
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
			await activeBridge.setPiProjectTrust(nextProjectTrust);
			setProjectTrust(nextProjectTrust);
			const [nextState, nextCommands, nextModels, nextThinkingLevels] = await Promise.all([
				activeBridge.loadPiState(),
				activeBridge.loadPiCommands(),
				activeBridge.loadPiModels(),
				activeBridge.loadPiThinkingLevels(),
			]);
			applyState(nextState);
			setCommands(nextCommands);
			setModels(nextModels);
			setThinkingLevels(nextThinkingLevels?.filter((level) => level !== "off"));
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
			await activeBridge.answerPiExtension(answer);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("admin.agent.error.extension"));
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (event.nativeEvent.isComposing) return;
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

	// Every handler above closes over this render's state, so publishing them directly would hand
	// each part a new context value on every keystroke. The stable object below forwards into the
	// current render's handler through a ref, which is what lets the value memo hold across a
	// re-render that changed nothing a part reads.
	const handlers: AgentChatInputActions = {
		setInspectorOpen,
		setDelivery,
		typeDraft,
		selectSuggestion,
		removeImage,
		addImage,
		submit,
		stop,
		changeModel,
		changeThinkingLevel,
		changeProjectTrust,
		answerExtension,
		onPaste,
		onKeyDown,
	};
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;
	const actions = useMemo<AgentChatInputActions>(
		() => ({
			setInspectorOpen: (open) => handlersRef.current.setInspectorOpen(open),
			setDelivery: (mode) => handlersRef.current.setDelivery(mode),
			typeDraft: (value) => handlersRef.current.typeDraft(value),
			selectSuggestion: (suggestion) => handlersRef.current.selectSuggestion(suggestion),
			removeImage: (image) => handlersRef.current.removeImage(image),
			addImage: (file) => handlersRef.current.addImage(file),
			submit: () => handlersRef.current.submit(),
			stop: () => handlersRef.current.stop(),
			changeModel: (value) => handlersRef.current.changeModel(value),
			changeThinkingLevel: (value) => handlersRef.current.changeThinkingLevel(value),
			changeProjectTrust: (value) => handlersRef.current.changeProjectTrust(value),
			answerExtension: (answer) => handlersRef.current.answerExtension(answer),
			onPaste: (event) => handlersRef.current.onPaste(event),
			onKeyDown: (event) => handlersRef.current.onKeyDown(event),
		}),
		[],
	);

	const value = useMemo<AgentChatInputContextValue>(
		() => ({
			disabled,
			variant,
			deliveryRule: rule,
			settings,
			fieldRef: ref,
			inputId,
			suggestionsId,
			draft,
			delivery,
			connection,
			harnessState: state,
			commands,
			models,
			thinkingLevels,
			projectTrust,
			settingsChanging,
			settingsDisabled,
			images,
			error,
			assistantText,
			activities,
			suggestions,
			activeSuggestion,
			activeSuggestionId,
			extension,
			extensionStatus,
			widget,
			inspectorOpen,
			...actions,
		}),
		[
			actions,
			activeSuggestion,
			activeSuggestionId,
			activities,
			assistantText,
			commands,
			connection,
			delivery,
			disabled,
			draft,
			error,
			extension,
			extensionStatus,
			images,
			inputId,
			inspectorOpen,
			models,
			projectTrust,
			ref,
			rule,
			settings,
			settingsChanging,
			settingsDisabled,
			state,
			suggestions,
			suggestionsId,
			thinkingLevels,
			variant,
			widget,
		],
	);

	return <AgentChatInputContext.Provider value={value}>{children}</AgentChatInputContext.Provider>;
}
