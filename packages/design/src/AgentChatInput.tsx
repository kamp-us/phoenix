import {
	Bot,
	Brain,
	ChevronDown,
	ChevronUp,
	FileImage,
	Paperclip,
	SendHorizontal,
	ShieldCheck,
	Square,
	X,
} from "lucide-react";
import {
	type ClipboardEvent,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {Alert} from "./Alert";
import {AgentActivity} from "./agent-chat/AgentActivity";
import {
	deliveryModeKeys,
	projectTrustKeys,
	thinkingLevelIcons,
	thinkingLevelKeys,
	toItems,
} from "./agent-chat/catalog";
import {HarnessWidget} from "./agent-chat/HarnessWidget";
import {Icon} from "./agent-chat/Icon";
import {fileAsImage, MAX_IMAGE_BYTES} from "./agent-chat/image";
import {mockCommands, mockFiles, mockModels, mockThinkingLevels} from "./agent-chat/mock-harness";
import {PiExtensionDialog} from "./agent-chat/PiExtensionDialog";
import {
	assistantMessageText,
	booleanValue,
	commandList,
	completionFor,
	deliveryMode,
	extensionRequest,
	isRecord,
	modelList,
	modelName,
	modelValue,
	projectTrustValue,
	providersCollide,
	runningModelLabel,
	selectedModelValue,
	stringValue,
	thinkingLevelList,
	thinkingLevelValue,
} from "./agent-chat/parse";
import {type PickerItem, SettingMenu} from "./agent-chat/SettingMenu";
import {SuggestionRow} from "./agent-chat/SuggestionRow";
import type {Activity, ConnectionState, ExtensionRequest, Suggestion} from "./agent-chat/types";
import {unavailableBridge} from "./agent-chat/unavailable-bridge";
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
} from "./agent-chat-bridge";
import {Kbd} from "./atoms";
import {Button} from "./Button";
import {Card} from "./Card";
import {Collapsible} from "./Collapsible";
import {Form, Input, Textarea} from "./Form";
import {useDesignT} from "./i18n";
import {Menu, type MenuItem} from "./Menu";
import {Select, type SelectItem} from "./Select";
import "./AgentChatInput.css";
import "./visually-hidden.css";

export interface AgentChatInputProps {
	readonly bridge?: AgentChatInputBridge;
	readonly initialValue?: string;
	readonly disabled?: boolean;
	readonly variant?: "harness" | "focused";
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

export function AgentChatInput({
	bridge,
	initialValue = "",
	disabled = false,
	variant = "harness",
	mockWhenUnavailable = false,
	onDraftChange,
	settings,
	ref,
}: AgentChatInputProps) {
	const activeBridge = bridge ?? unavailableBridge;
	const t = useDesignT();
	const inputId = useId();
	const suggestionsId = `${inputId}-suggestions`;
	const imageInputRef = useRef<HTMLInputElement>(null);
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
	// A harness that offers no commands does not advertise the sigil: typing `/` against an empty
	// catalog opens nothing, and a hint promising a picker that never appears reads as a fault.
	const commandHint =
		commands.length > 0 ? (
			<>
				<Kbd>/</Kbd> {t("admin.agent.hint.command")} ·{" "}
			</>
		) : null;

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
			const requestedDelivery =
				variant === "focused"
					? connection === "working"
						? delivery === "prompt"
							? "follow_up"
							: delivery
						: "prompt"
					: delivery;
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

	const model = runningModelLabel(state, models ?? []);
	// Manti's `SelectItem.label` is `string`, and the select collection stringifies it for typeahead
	// (`itemToString: (item) => item.label`), so this list carries the provider in the label itself
	// while the Menu-backed picker below renders it as its own dimmed span. See #8065.
	// Each list stays `undefined` while its offer is unresolved, so the pickers are handed the same
	// three-way answer the bridge gave rather than a flattened array (#8425).
	const modelItems = useMemo<SelectItem[] | undefined>(
		() =>
			models?.map((candidate) => ({
				value: modelValue(candidate),
				label: providersCollide(models)
					? `${candidate.name} (${candidate.provider})`
					: candidate.name,
			})),
		[models],
	);
	const thinkingItems = useMemo<SelectItem[] | undefined>(
		() => thinkingLevels?.map((level) => ({value: level, label: t(thinkingLevelKeys[level])})),
		[thinkingLevels, t],
	);
	const focusedModelItems = useMemo<PickerItem[] | undefined>(
		() =>
			models?.map((candidate) => ({
				value: modelValue(candidate),
				label: candidate.name,
				...(providersCollide(models) ? {note: candidate.provider} : {}),
			})),
		[models],
	);
	const focusedThinkingItems = useMemo<PickerItem[] | undefined>(
		() =>
			thinkingLevels?.map((level) => ({
				value: level,
				label: t(thinkingLevelKeys[level]),
				icon: thinkingLevelIcons[level],
			})),
		[thinkingLevels, t],
	);
	// The host's own answer and nothing else. Falling back to the first row named a model nobody
	// picked as the one the session runs on, and a picker opened with that row already checked read
	// as a choice already made (#8573).
	const selectedModel = selectedModelValue(state);
	const stateThinking = thinkingLevelValue(state?.thinkingLevel);
	const selectedThinking = stateThinking !== "off" ? stateThinking : undefined;
	// Each selection as a row of its own, for the picker to name when the offer carries no row for
	// it — the pick an operator holds while no session's catalog is live (#8542).
	const heldModel = useMemo<PickerItem | undefined>(() => {
		const name = modelName(state);
		return selectedModel && name ? {value: selectedModel, label: name} : undefined;
	}, [selectedModel, state]);
	const heldThinking = useMemo<PickerItem | undefined>(
		() =>
			selectedThinking === undefined
				? undefined
				: {
						value: selectedThinking,
						label: t(thinkingLevelKeys[selectedThinking]),
						icon: thinkingLevelIcons[selectedThinking],
					},
		[selectedThinking, t],
	);
	const settingsDisabled = disabled || settingsChanging || connection !== "ready";
	const offeredThinking = thinkingItems?.length ?? 0;
	const thinkingDisabled =
		settingsDisabled ||
		offeredThinking === 0 ||
		(offeredThinking === 1 && selectedThinking !== undefined);
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
							ref={ref}
							id={inputId}
							className="kp-agent-chat__textarea"
							role="combobox"
							aria-autocomplete="list"
							aria-expanded={suggestions.length > 0}
							aria-controls={suggestions.length > 0 ? suggestionsId : undefined}
							aria-activedescendant={activeSuggestionId}
							label={<span className="kp-visually-hidden">{t("admin.agent.compose.label")}</span>}
							placeholder={t("admin.agent.compose.placeholder")}
							value={draft}
							onChange={(event) => {
								editDraft(event.currentTarget.value);
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
								id={suggestionsId}
								className="kp-agent-chat__suggestions"
								role="listbox"
								aria-label={t("admin.agent.completions")}
							>
								{suggestions.map((suggestion, index) => (
									<SuggestionRow
										id={`${suggestionsId}-${index}`}
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
											held={heldModel}
											onValueChange={(value) => void changeModel(value)}
											disabled={settingsDisabled || (focusedModelItems?.length ?? 0) < 2}
										/>
										<SettingMenu
											label={t("admin.agent.setting.thinking")}
											items={focusedThinkingItems}
											value={selectedThinking}
											held={heldThinking}
											onValueChange={(value) => void changeThinkingLevel(value)}
											disabled={thinkingDisabled}
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
												items={modelItems ?? []}
												value={selectedModel ? [selectedModel] : []}
												onValueChange={(values) => void changeModel(values[0])}
												placement="top-start"
												size="sm"
												disabled={settingsDisabled || (modelItems?.length ?? 0) < 2}
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
												items={thinkingItems ?? []}
												value={selectedThinking ? [selectedThinking] : []}
												placeholder={t(
													thinkingItems === undefined
														? "admin.agent.picker.loading"
														: thinkingItems.length === 0
															? "admin.agent.picker.empty"
															: "admin.agent.picker.none",
												)}
												onValueChange={(values) => void changeThinkingLevel(values[0])}
												placement="top-start"
												size="sm"
												disabled={thinkingDisabled}
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
								{settings}
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
						{t("admin.agent.hint.newline")} · {commandHint}
						<Kbd>@</Kbd> {t("admin.agent.hint.file")} · {t("admin.agent.hint.pasteImage")}
					</p>
				) : (
					<p className="kp-agent-chat__hint">
						{commandHint}
						<Kbd>@</Kbd> {t("admin.agent.hint.file")} · {t("admin.agent.hint.addOrPasteImage")}
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
