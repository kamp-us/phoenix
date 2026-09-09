import type {ReactNode} from "react";
import {Card} from "../Card";
import {useAgentChatInput} from "./Root";

/** The composer's frame: the card everything else sits in. */
export function AgentChatSurface({children}: {readonly children: ReactNode}) {
	// Read for the placement guard alone — see `Frame.tsx`.
	useAgentChatInput();

	return (
		<Card className="kp-agent-chat__composer" data-testid="agent-chat-input">
			{children}
		</Card>
	);
}
