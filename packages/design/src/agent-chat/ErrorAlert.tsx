import {Alert} from "../Alert";
import {useAgentChatInput} from "./Root";

/** The last send's failure, where the composer reports it. Renders nothing while there is none. */
export function AgentChatError() {
	const {error} = useAgentChatInput();

	return error ? (
		<Alert className="kp-agent-chat__error" variant="danger">
			{error}
		</Alert>
	) : null;
}
