import {PiExtensionDialog} from "./PiExtensionDialog";
import {useAgentChatInput} from "./Root";

/** The harness extension's question, while one is outstanding. */
export function AgentChatExtensionDialog() {
	const {extension, answerExtension} = useAgentChatInput();

	return extension ? <PiExtensionDialog request={extension} onAnswer={answerExtension} /> : null;
}
