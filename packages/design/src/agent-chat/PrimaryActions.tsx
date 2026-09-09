import {SendHorizontal, Square} from "lucide-react";
import {Button} from "../Button";
import {useDesignT} from "../i18n";
import {Select} from "../Select";
import {AgentChatControl} from "./Control";
import {deliveryModeKeys, toItems} from "./catalog";
import {requestedDelivery} from "./delivery";
import {Icon} from "./Icon";
import {deliveryMode} from "./parse";
import {useAgentChatInput} from "./Root";

/**
 * How a draft leaves the composer: the delivery picker where it renders inline, the stop
 * affordance while the harness runs, and the send button. The button's copy is resolved through
 * the same `requestedDelivery` the send itself uses, so the label cannot name a delivery the
 * payload will not carry (#8691).
 */
export function AgentChatPrimaryActions() {
	const {disabled, variant, delivery, deliveryRule, connection, setDelivery, stop} =
		useAgentChatInput();
	const t = useDesignT();
	const requested = requestedDelivery(deliveryRule, connection, delivery);

	return (
		<div className="kp-agent-chat__send-controls">
			{variant === "harness" ? (
				<Select
					className="kp-agent-chat__delivery"
					label={<span className="kp-visually-hidden">{t("admin.agent.select.delivery")}</span>}
					items={toItems(deliveryModeKeys, t)}
					value={[delivery]}
					onValueChange={(values) => {
						const nextDelivery = deliveryMode(values[0]);
						if (nextDelivery) setDelivery(nextDelivery);
					}}
					placement="top-end"
					size="sm"
				/>
			) : null}
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
