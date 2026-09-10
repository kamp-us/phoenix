import {SendHorizontal, Square} from "lucide-react";
import {Button} from "../Button";
import {useDesignT} from "../i18n";
import {AgentChatControl} from "./Control";
import {requestedDelivery} from "./delivery";
import {Icon} from "./Icon";
import {useAgentChatInput} from "./Root";

/**
 * How a draft leaves the composer: the stop affordance while the harness runs, and the send
 * button. The button's copy is resolved through
 * the same `requestedDelivery` the send itself uses, so the label cannot name a delivery the
 * payload will not carry (#8691).
 */
export function AgentChatPrimaryActions() {
	const {disabled, delivery, deliveryRule, connection, stop} = useAgentChatInput();
	const t = useDesignT();
	const requested = requestedDelivery(deliveryRule, connection, delivery);

	return (
		<div className="kp-agent-chat__send-controls">
			{connection === "working" ? (
				<AgentChatControl icon={Square} onClick={() => void stop()}>
					{" "}
					{t("admin.agent.stop")}
				</AgentChatControl>
			) : null}
			<Button
				type="submit"
				variant="primary"
				size="sm"
				disabled={disabled || connection === "loading" || connection === "unavailable"}
			>
				{t(
					connection !== "working"
						? "admin.agent.send"
						: requested === "steer"
							? "admin.agent.delivery.steer"
							: requested === "follow_up"
								? "admin.agent.delivery.followUp"
								: "admin.agent.queue",
				)}{" "}
				<Icon icon={SendHorizontal} size={16} />
			</Button>
		</div>
	);
}
