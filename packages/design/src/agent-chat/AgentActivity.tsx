import {Card} from "../Card";
import {useDesignT} from "../i18n";
import type {Activity} from "./types";
import "./AgentActivity.css";

export function AgentActivity({
	assistantText,
	activities,
}: {
	readonly assistantText: string;
	readonly activities: readonly Activity[];
}) {
	const t = useDesignT();
	return (
		<Card className="kp-agent-chat__activity" aria-live="polite">
			<p className="kp-agent-chat__activity-title">{t("admin.agent.activity.title")}</p>
			{assistantText ? (
				<pre className="kp-agent-chat__assistant-text">{assistantText}</pre>
			) : (
				<p className="kp-agent-chat__empty">{t("admin.agent.activity.empty")}</p>
			)}
			{activities.length > 0 ? (
				<ul className="kp-agent-chat__activity-list">
					{activities.map((activity) => (
						<li key={activity.id}>{activity.text}</li>
					))}
				</ul>
			) : null}
		</Card>
	);
}
