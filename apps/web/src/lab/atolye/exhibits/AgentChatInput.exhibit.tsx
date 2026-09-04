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
