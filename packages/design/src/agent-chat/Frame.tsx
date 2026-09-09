import type {ReactNode} from "react";
import {useDesignT} from "../i18n";
import {HarnessWidget} from "./HarnessWidget";
import {useAgentChatInput} from "./Root";

/**
 * The composer's outermost element: the labelled region everything else sits in, and — on the
 * harness variant — the widget the harness paints above the card.
 */
export function AgentChatFrame({children}: {readonly children: ReactNode}) {
	const {variant, widget} = useAgentChatInput();
	const t = useDesignT();

	return (
		<section
			className={`kp-agent-chat kp-agent-chat--${variant}`}
			aria-label={t("admin.agent.label")}
		>
			{variant === "harness" && widget ? <HarnessWidget lines={widget} /> : null}
			{children}
		</section>
	);
}
