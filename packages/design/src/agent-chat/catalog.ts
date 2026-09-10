import {
	ChevronDown,
	ChevronsDown,
	ChevronsUp,
	ChevronUp,
	CircleOff,
	type LucideIcon,
	Minus,
	Sparkles,
} from "lucide-react";
import type {PiThinkingLevel} from "../agent-chat-bridge";
import type {DesignCatalogKey} from "../i18n";

export const thinkingLevelKeys: Readonly<Record<PiThinkingLevel, DesignCatalogKey>> = {
	off: "admin.agent.thinking.off",
	minimal: "admin.agent.thinking.minimal",
	low: "admin.agent.thinking.low",
	medium: "admin.agent.thinking.medium",
	high: "admin.agent.thinking.high",
	xhigh: "admin.agent.thinking.xhigh",
	max: "admin.agent.thinking.max",
	ultra: "admin.agent.thinking.ultra",
};

export const thinkingLevelIcons: Readonly<Record<PiThinkingLevel, LucideIcon>> = {
	off: CircleOff,
	minimal: ChevronsDown,
	low: ChevronDown,
	medium: Minus,
	high: ChevronUp,
	xhigh: ChevronsUp,
	max: Sparkles,
	ultra: Sparkles,
};
