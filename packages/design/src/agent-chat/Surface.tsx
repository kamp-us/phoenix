import type {ReactNode} from "react";
import {Card} from "../Card";
import {useDesignT} from "../i18n";
import {runningModelLabel} from "./parse";
import {useAgentChatInput} from "./Root";

/**
 * The composer's frame: the card everything else sits in, and the status row that names the
 * connection above it.
 */
export function AgentChatSurface({children}: {readonly children: ReactNode}) {
	const {variant, connection, harnessState, models, extensionStatus} = useAgentChatInput();
	const t = useDesignT();
	const model = runningModelLabel(harnessState, models ?? []);
	const status =
		connection === "loading"
			? t("admin.agent.status.loading")
			: connection === "working"
				? t("admin.agent.status.working")
				: connection === "ready"
					? model
						? t("admin.agent.status.readyWithModel", {model})
						: t("admin.agent.status.ready")
					: t("admin.agent.status.unavailable");

	return (
		<Card className="kp-agent-chat__composer" data-testid="agent-chat-input">
			{variant === "harness" ? (
				<div className="kp-agent-chat__status-row">
					<p className="kp-agent-chat__status" aria-live="polite">
						{status}
						{extensionStatus ? ` · ${extensionStatus}` : ""}
					</p>
					<p className="kp-agent-chat__scope">{t("admin.agent.scope")}</p>
				</div>
			) : null}
			{children}
		</Card>
	);
}
