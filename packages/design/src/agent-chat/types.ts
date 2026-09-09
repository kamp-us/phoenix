import type {PiCommand} from "../agent-chat-bridge";

export type ConnectionState = "loading" | "ready" | "unavailable" | "working";

export interface Completion {
	readonly kind: "command" | "file";
	readonly query: string;
	readonly start: number;
	readonly end: number;
}

export type Suggestion =
	| {readonly kind: "command"; readonly command: PiCommand}
	| {readonly kind: "file"; readonly path: string};

export interface Activity {
	readonly id: number;
	readonly text: string;
}

export interface ExtensionRequest {
	readonly id: string;
	readonly method: "select" | "confirm" | "input" | "editor";
	readonly title: string;
	readonly message?: string;
	readonly options?: readonly string[];
	readonly placeholder?: string;
	readonly prefill?: string;
}
