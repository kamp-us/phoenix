import {ShieldCheck} from "lucide-react";
import {useDesignT} from "../i18n";
import {Menu, type MenuItem} from "../Menu";
import {AgentChatControl} from "./Control";
import {requestedDelivery} from "./delivery";
import {useAgentChatInput} from "./Root";

/**
 * The disclosure holding the controls the composer gives no row of its own: project trust, and the
 * delivery mode while the harness is working. Its delivery rows check against the same
 * `requestedDelivery` the send resolves, so the menu and the payload never disagree.
 */
export function AgentChatOverflow() {
	const {
		delivery,
		deliveryRule,
		connection,
		projectTrust,
		settingsDisabled,
		setDelivery,
		changeProjectTrust,
	} = useAgentChatInput();
	const t = useDesignT();
	const requested = requestedDelivery(deliveryRule, connection, delivery);

	const items: MenuItem[] = [
		...(connection === "working"
			? [
					{
						type: "group" as const,
						label: t("admin.agent.menu.streaming"),
						items: [
							{
								type: "radio" as const,
								value: "delivery:steer",
								label: t("admin.agent.delivery.steer"),
								checked: requested === "steer",
							},
							{
								type: "radio" as const,
								value: "delivery:follow_up",
								label: t("admin.agent.delivery.followUp"),
								checked: requested === "follow_up",
							},
						],
					},
					{type: "separator" as const},
				]
			: []),
		{
			type: "group",
			label: t("admin.agent.menu.projectResources"),
			items: [
				{
					type: "radio",
					value: "trust:approve",
					label: t("admin.agent.trust.load"),
					checked: projectTrust === "approve",
					disabled: settingsDisabled,
				},
				{
					type: "radio",
					value: "trust:no-approve",
					label: t("admin.agent.trust.skip"),
					checked: projectTrust === "no-approve",
					disabled: settingsDisabled,
				},
			],
		},
	];

	return (
		<Menu
			placement="top-start"
			ariaLabel={t("admin.agent.settings")}
			trigger={
				<AgentChatControl
					icon={ShieldCheck}
					iconSize={14}
					className="kp-agent-chat__resources-button"
					aria-label={t("admin.agent.resources.label")}
				>
					{t("admin.agent.resources")}
				</AgentChatControl>
			}
			items={items}
			onSelect={(value) => {
				if (value === "delivery:steer") setDelivery("steer");
				if (value === "delivery:follow_up") setDelivery("follow_up");
				if (value === "trust:approve") void changeProjectTrust("approve");
				if (value === "trust:no-approve") void changeProjectTrust("no-approve");
			}}
		/>
	);
}
