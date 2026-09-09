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
import {useMemo, useRef} from "react";
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
import {PiExtensionDialog} from "./agent-chat/PiExtensionDialog";
import {
	deliveryMode,
	modelName,
	modelValue,
	providersCollide,
	runningModelLabel,
	selectedModelValue,
	thinkingLevelValue,
} from "./agent-chat/parse";
import {type AgentChatInputProps, AgentChatInputRoot, useAgentChatInput} from "./agent-chat/Root";
import {type PickerItem, SettingMenu} from "./agent-chat/SettingMenu";
import {SuggestionRow} from "./agent-chat/SuggestionRow";
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

export type {AgentChatInputProps} from "./agent-chat/Root";

function AgentChatInputBody() {
	const {
		disabled,
		variant,
		settings,
		fieldRef,
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
	} = useAgentChatInput();
	const t = useDesignT();
	const imageInputRef = useRef<HTMLInputElement>(null);

	// A harness that offers no commands does not advertise the sigil: typing `/` against an empty
	// catalog opens nothing, and a hint promising a picker that never appears reads as a fault.
	const commandHint =
		commands.length > 0 ? (
			<>
				<Kbd>/</Kbd> {t("admin.agent.hint.command")} ·{" "}
			</>
		) : null;

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
										onClick={() => removeImage(image)}
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
							ref={fieldRef}
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
							onChange={(event) => typeDraft(event.currentTarget.value)}
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

export function AgentChatInput(props: AgentChatInputProps) {
	return (
		<AgentChatInputRoot {...props}>
			<AgentChatInputBody />
		</AgentChatInputRoot>
	);
}

AgentChatInput.Root = AgentChatInputRoot;
