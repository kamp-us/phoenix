export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelRef {
	readonly provider: string;
	readonly id: string;
}

export interface ModelCost {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface ModelMetadata {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly api: string;
	readonly reasoning: boolean;
	readonly input: ("text" | "image")[];
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly cost: ModelCost;
	readonly supportedThinkingLevels: ThinkingLevel[];
	readonly authenticated: boolean;
}
