import type {PiCommand, PiModel, PiThinkingLevel} from "../agent-chat-bridge";
import type {DesignTranslate} from "../i18n";

export const mockModels: readonly PiModel[] = [
	{provider: "openai", id: "gpt-5.5", name: "GPT-5.5"},
	{provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna"},
	{provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol"},
	{provider: "openai", id: "gpt-5.6-terra", name: "GPT-5.6 Terra"},
];

export const mockThinkingLevels: readonly PiThinkingLevel[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
];

export const mockCommands = (t: DesignTranslate): readonly PiCommand[] => [
	{name: "review", description: t("admin.agent.mock.command.review")},
	{name: "compact", description: t("admin.agent.mock.command.compact")},
];

export const mockFiles = ["apps/web/src/App.tsx", "packages/design/src/AgentChatInput.tsx"];
