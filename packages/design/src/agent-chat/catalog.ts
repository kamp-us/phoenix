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
import type {PiDeliveryMode, PiProjectTrust, PiThinkingLevel} from "../agent-chat-bridge";
import type {DesignCatalogKey, DesignTranslate} from "../i18n";
import type {SelectItem} from "../Select";

export const deliveryModeKeys: readonly {value: PiDeliveryMode; key: DesignCatalogKey}[] = [
	{value: "prompt", key: "admin.agent.delivery.prompt"},
	{value: "steer", key: "admin.agent.delivery.steer"},
	{value: "follow_up", key: "admin.agent.delivery.followUp"},
];

export const projectTrustKeys: readonly {value: PiProjectTrust; key: DesignCatalogKey}[] = [
	{value: "approve", key: "admin.agent.trust.approve"},
	{value: "no-approve", key: "admin.agent.trust.ignore"},
];

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

export const toItems = (
	entries: readonly {value: string; key: DesignCatalogKey}[],
	t: DesignTranslate,
): SelectItem[] => entries.map(({value, key}) => ({value, label: t(key)}));

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
