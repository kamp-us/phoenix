import type {ReactNode} from "react";
import {useDesignT} from "../i18n";
import {useAgentChatInput} from "./Root";

/** The composer's outermost element: the labelled region everything else sits in. */
export function AgentChatFrame({children}: {readonly children: ReactNode}) {
	// Read for the placement guard alone: this part paints no state of its own, and without the
	// read it would be the one part that renders happily outside a Root (`Root.test.tsx`).
	useAgentChatInput();
	const t = useDesignT();

	return (
		<section className="kp-agent-chat" aria-label={t("admin.agent.label")}>
			{children}
		</section>
	);
}
