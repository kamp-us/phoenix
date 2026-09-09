import {Bot, Brain, ShieldCheck} from "lucide-react";
import {type ReactNode, useMemo} from "react";
import {useDesignT} from "../i18n";
import {Select, type SelectItem} from "../Select";
import {projectTrustKeys, thinkingLevelIcons, thinkingLevelKeys, toItems} from "./catalog";
import {Icon} from "./Icon";
import {
	modelName,
	modelValue,
	providersCollide,
	selectedModelValue,
	thinkingLevelValue,
} from "./parse";
import {useAgentChatInput} from "./Root";
import {type PickerItem, SettingMenu} from "./SettingMenu";

/**
 * The composer's settings fieldset — model, thinking effort and, on the harness variant, project
 * trust.
 *
 * With no children it renders the controls this component owns followed by the host's `settings`
 * slot, which is what the exported composer assembles. Children replace those controls, for a host
 * that wants the fieldset with a row set of its own; the slot is untouched either way.
 */
export function AgentChatSettings({children}: {readonly children?: ReactNode}) {
	const {
		variant,
		settings,
		harnessState: state,
		models,
		thinkingLevels,
		projectTrust,
		settingsDisabled,
		changeModel,
		changeThinkingLevel,
		changeProjectTrust,
	} = useAgentChatInput();
	const t = useDesignT();

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
	const offeredThinking = thinkingItems?.length ?? 0;
	const thinkingDisabled =
		settingsDisabled ||
		offeredThinking === 0 ||
		(offeredThinking === 1 && selectedThinking !== undefined);

	return (
		<fieldset className="kp-agent-chat__settings">
			<legend className="kp-visually-hidden">{t("admin.agent.settings")}</legend>
			{children ?? (
				<>
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
										<span className="kp-visually-hidden">{t("admin.agent.select.model")}</span>
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
										<span className="kp-visually-hidden">{t("admin.agent.select.thinking")}</span>
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
										<span className="kp-visually-hidden">{t("admin.agent.select.trust")}</span>
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
				</>
			)}
		</fieldset>
	);
}
