import {Card} from "../Card";
import {useDesignT} from "../i18n";
import "./HarnessWidget.css";

export function HarnessWidget({lines}: {readonly lines: readonly string[]}) {
	const t = useDesignT();
	return (
		<Card className="kp-agent-chat__widget" role="status">
			<p className="kp-agent-chat__widget-title">{t("admin.agent.extension.title")}</p>
			<pre>{lines.join("\n")}</pre>
		</Card>
	);
}
