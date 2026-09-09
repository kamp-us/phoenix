import type {ReactNode} from "react";
import {AgentChatAttach} from "./Attach";
import {AgentChatOverflow} from "./Overflow";
import {AgentChatPrimaryActions} from "./PrimaryActions";
import {useAgentChatInput} from "./Root";
import {AgentChatSettings} from "./Settings";

/**
 * The control row under the field: what the operator can attach and configure on the left, and how
 * a draft leaves the composer on the right.
 *
 * Children replace the left group only — the send group is the row's other half and a host that
 * dropped it would have a composer nothing leaves.
 */
export function AgentChatToolbar({children}: {readonly children?: ReactNode}) {
	const {variant} = useAgentChatInput();

	return (
		<div className="kp-agent-chat__actions">
			<div className="kp-agent-chat__primary-controls">
				{children ?? (
					<>
						{variant === "focused" ? <AgentChatAttach /> : null}
						<AgentChatSettings />
						{variant === "focused" ? <AgentChatOverflow /> : null}
					</>
				)}
			</div>
			<AgentChatPrimaryActions />
		</div>
	);
}
