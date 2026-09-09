import {Paperclip, SendHorizontal, ShieldCheck, Square} from "lucide-react";
import {useRef} from "react";
import {Button} from "../Button";
import {Input} from "../Form";
import {useDesignT} from "../i18n";
import {Menu, type MenuItem} from "../Menu";
import {Select} from "../Select";
import {AgentChatControl} from "./Control";
import {deliveryModeKeys, toItems} from "./catalog";
import {Icon} from "./Icon";
import {deliveryMode} from "./parse";
import {useAgentChatInput} from "./Root";
import {AgentChatSettings} from "./Settings";

/**
 * The control row under the field: what the operator can attach and configure on the left, and how
 * a draft leaves the composer on the right.
 */
export function AgentChatToolbar() {
	const {
		disabled,
		variant,
		delivery,
		connection,
		projectTrust,
		settingsDisabled,
		setDelivery,
		addImage,
		stop,
		changeProjectTrust,
	} = useAgentChatInput();
	const t = useDesignT();
	const imageInputRef = useRef<HTMLInputElement>(null);

	const focusedDelivery =
		connection === "working" ? (delivery === "prompt" ? "follow_up" : delivery) : "prompt";
	const focusedMenuItems: MenuItem[] = [
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
								checked: focusedDelivery === "steer",
							},
							{
								type: "radio" as const,
								value: "delivery:follow_up",
								label: t("admin.agent.delivery.followUp"),
								checked: focusedDelivery === "follow_up",
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
		<div className="kp-agent-chat__actions">
			<div className="kp-agent-chat__primary-controls">
				{variant === "focused" ? (
					<>
						<Input
							ref={imageInputRef}
							className="kp-visually-hidden"
							label={t("admin.agent.image.add")}
							type="file"
							accept="image/*"
							tabIndex={-1}
							onChange={(event) => {
								void addImage(event.currentTarget.files?.[0]);
								event.currentTarget.value = "";
							}}
						/>
						<AgentChatControl
							icon={Paperclip}
							className="kp-agent-chat__icon-button"
							aria-label={t("admin.agent.image.add")}
							onClick={() => imageInputRef.current?.click()}
							disabled={disabled}
						/>
					</>
				) : null}
				<AgentChatSettings />
				{variant === "focused" ? (
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
						items={focusedMenuItems}
						onSelect={(value) => {
							if (value === "delivery:steer") setDelivery("steer");
							if (value === "delivery:follow_up") setDelivery("follow_up");
							if (value === "trust:approve") void changeProjectTrust("approve");
							if (value === "trust:no-approve") void changeProjectTrust("no-approve");
						}}
					/>
				) : null}
			</div>
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
						variant === "focused" && connection === "working"
							? focusedDelivery === "steer"
								? "admin.agent.delivery.steer"
								: "admin.agent.delivery.followUp"
							: connection === "working"
								? "admin.agent.queue"
								: "admin.agent.send",
					)}{" "}
					<Icon icon={SendHorizontal} size={16} />
				</Button>
			</div>
		</div>
	);
}
