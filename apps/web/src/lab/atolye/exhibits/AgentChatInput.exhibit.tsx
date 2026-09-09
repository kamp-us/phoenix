import {AgentChatInput} from "@kampus/design";
import type * as React from "react";
import {agentChatInputBridge} from "../../../components/agent/piHarness";
import {defineExhibit} from "../exhibit";

export const agentChatInputExhibit = defineExhibit<React.ComponentProps<typeof AgentChatInput>>({
	id: "agent-chat-input",
	title: "Agent Chat Input",
	summary:
		"Pi RPC ile çalışan; / komutları, @ dosya anmaları, görsel ekleri ve eklenti diyalogları için yerel prototip.",
	component: AgentChatInput,
	fixedProps: {bridge: agentChatInputBridge, mockWhenUnavailable: true},
	knobs: {
		variant: {
			kind: "enum",
			label: "Varyant",
			default: "focused",
			options: [
				{value: "focused", label: "Odaklı"},
				{value: "harness", label: "Harness"},
			],
		},
		initialValue: {
			kind: "string",
			label: "Başlangıç istemi",
			default: "",
			placeholder: "Pi'ye bir görev yaz",
		},
		disabled: {kind: "boolean", label: "Devre dışı", default: false},
	},
});

/**
 * The same composer assembled from its compound parts instead of taken whole — the shape a host
 * copies when it has to place a control of its own inside the composer, as Tuval's chat window
 * does with its mode picker.
 */
function AgentChatInputParts({
	variant,
	initialValue,
	disabled,
}: {
	readonly variant?: "harness" | "focused";
	readonly initialValue?: string;
	readonly disabled?: boolean;
}) {
	return (
		<AgentChatInput.Root
			bridge={agentChatInputBridge}
			mockWhenUnavailable
			variant={variant}
			initialValue={initialValue}
			disabled={disabled}
		>
			<AgentChatInput.Frame>
				<AgentChatInput.Surface>
					<AgentChatInput.Form>
						<AgentChatInput.Field />
						<AgentChatInput.Toolbar />
					</AgentChatInput.Form>
					<AgentChatInput.Hint />
					<AgentChatInput.Error />
				</AgentChatInput.Surface>
				<AgentChatInput.Inspector />
				<AgentChatInput.ExtensionDialog />
			</AgentChatInput.Frame>
		</AgentChatInput.Root>
	);
}

export const agentChatInputPartsExhibit = defineExhibit<
	React.ComponentProps<typeof AgentChatInputParts>
>({
	id: "agent-chat-input-parts",
	title: "Agent Chat Input (compound parts)",
	summary:
		"Aynı besteci, tek parça yerine bileşik parçalarından kurulmuş: Root durumu taşır, her parça onu okur.",
	component: AgentChatInputParts,
	knobs: {
		variant: {
			kind: "enum",
			label: "Varyant",
			default: "focused",
			options: [
				{value: "focused", label: "Odaklı"},
				{value: "harness", label: "Harness"},
			],
		},
		initialValue: {
			kind: "string",
			label: "Başlangıç istemi",
			default: "",
			placeholder: "Pi'ye bir görev yaz",
		},
		disabled: {kind: "boolean", label: "Devre dışı", default: false},
	},
});
