import {useMemo} from "react";
import {useDesignT} from "../i18n";
import {thinkingLevelIcons, thinkingLevelKeys} from "./catalog";
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
 * The settings rows the composer owns: model and thinking effort. Project trust has no row here —
 * it lives in the overflow menu.
 *
 * It is its own part so a host that fills `Settings` with a row set of its own can still place
 * these rows in it, rather than choosing between the composer's controls and its own.
 */
export function AgentChatPickers() {
	const {
		harnessState: state,
		models,
		thinkingLevels,
		settingsDisabled,
		changeModel,
		changeThinkingLevel,
	} = useAgentChatInput();
	const t = useDesignT();

	// Each list stays `undefined` while its offer is unresolved, so the pickers are handed the same
	// three-way answer the bridge gave rather than a flattened array (#8425).
	const modelItems = useMemo<PickerItem[] | undefined>(
		() =>
			models?.map((candidate) => ({
				value: modelValue(candidate),
				label: candidate.name,
				...(providersCollide(models) ? {note: candidate.provider} : {}),
			})),
		[models],
	);
	const thinkingItems = useMemo<PickerItem[] | undefined>(
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
		<>
			<SettingMenu
				label={t("admin.agent.setting.model")}
				items={modelItems}
				value={selectedModel}
				held={heldModel}
				onValueChange={(value) => void changeModel(value)}
				disabled={settingsDisabled || (modelItems?.length ?? 0) < 2}
			/>
			<SettingMenu
				label={t("admin.agent.setting.thinking")}
				items={thinkingItems}
				value={selectedThinking}
				held={heldThinking}
				onValueChange={(value) => void changeThinkingLevel(value)}
				disabled={thinkingDisabled}
			/>
		</>
	);
}
