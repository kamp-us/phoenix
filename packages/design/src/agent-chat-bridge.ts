export type PiDeliveryMode = "prompt" | "steer" | "follow_up";
export type PiStreamingBehavior = "steer" | "followUp";
export type PiProjectTrust = "approve" | "no-approve";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiCommand {
	readonly name: string;
	readonly description?: string;
	readonly source?: string;
}

export interface PiModel {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
}

export interface PiImage {
	readonly data: string;
	readonly mimeType: string;
	readonly name: string;
}

export interface PiEvent {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface PiExtensionAnswer {
	readonly id: string;
	readonly value?: string;
	readonly confirmed?: boolean;
	readonly cancelled?: true;
}

export interface AgentChatInputBridge {
	readonly loadPiState: () => Promise<Record<string, unknown>>;
	readonly loadPiCommands: () => Promise<readonly PiCommand[]>;
	/**
	 * What the host offers, or `undefined` while it does not know yet. The two are different facts
	 * and an empty array is only ever the second one: a host whose agent starts after the composer
	 * answers `undefined` until its agent reports, and a host whose agent reports no rows answers
	 * `[]`. Collapsing them left a backend that offers nothing reading as one still loading (#8425).
	 */
	readonly loadPiModels: () => Promise<readonly PiModel[] | undefined>;
	readonly loadPiThinkingLevels: () => Promise<readonly PiThinkingLevel[] | undefined>;
	readonly loadPiFiles: (query: string) => Promise<readonly string[]>;
	readonly setPiModel: (model: PiModel) => Promise<void>;
	readonly setPiThinkingLevel: (level: PiThinkingLevel) => Promise<void>;
	readonly setPiProjectTrust: (projectTrust: PiProjectTrust) => Promise<void>;
	readonly sendPiPrompt: (options: {
		readonly type: PiDeliveryMode;
		readonly message: string;
		readonly images?: readonly PiImage[];
		readonly streamingBehavior?: PiStreamingBehavior;
	}) => Promise<void>;
	readonly abortPi: () => Promise<void>;
	readonly answerPiExtension: (answer: PiExtensionAnswer) => Promise<void>;
	readonly subscribeToPiEvents: (
		onEvent: (event: PiEvent) => void,
		onError: () => void,
	) => () => void;
}

export type AgentChatInputBridgeEvent = PiEvent;
