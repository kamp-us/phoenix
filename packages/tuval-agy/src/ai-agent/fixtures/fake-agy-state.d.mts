export interface ConversationState {
	readonly steps: number;
	readonly turns: number;
	readonly input: number;
	readonly output: number;
}

export declare const firstLaunch: ConversationState;

export declare const readConversationState: (path: string) => ConversationState;

export declare const saveConversationState: (path: string, state: ConversationState) => void;
