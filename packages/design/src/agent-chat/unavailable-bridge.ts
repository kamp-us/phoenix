import type {AgentChatInputBridge} from "../agent-chat-bridge";

export const unavailableBridge: AgentChatInputBridge = {
	loadPiState: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	loadPiCommands: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	loadPiModels: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	loadPiThinkingLevels: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	loadPiFiles: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	setPiModel: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	setPiThinkingLevel: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	setPiProjectTrust: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	sendPiPrompt: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	abortPi: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	answerPiExtension: () => Promise.reject(new Error("Pi harness kullanılamıyor.")),
	subscribeToPiEvents: () => () => undefined,
};
