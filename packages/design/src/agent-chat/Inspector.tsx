import {ChevronDown, ChevronUp} from "lucide-react";
import {Collapsible} from "../Collapsible";
import {useDesignT} from "../i18n";
import {AgentActivity} from "./AgentActivity";
import {HarnessWidget} from "./HarnessWidget";
import {Icon} from "./Icon";
import {useAgentChatInput} from "./Root";

/**
 * What the harness is doing under the composer: the focused variant folds it behind a disclosure
 * that counts the activities, the harness variant lays it out flat.
 */
export function AgentChatInspector() {
	const {variant, widget, assistantText, activities, inspectorOpen, setInspectorOpen} =
		useAgentChatInput();
	const t = useDesignT();

	return variant === "focused" ? (
		<Collapsible
			className="kp-agent-chat__inspector"
			open={inspectorOpen}
			onOpenChange={setInspectorOpen}
			indicator={false}
			trigger={
				<span className="kp-agent-chat__inspector-trigger">
					<span className="kp-agent-chat__inspector-title">
						{t("admin.agent.inspector")}
						{activities.length > 0 ? <span>{activities.length}</span> : null}
					</span>
					<Icon icon={inspectorOpen ? ChevronUp : ChevronDown} size={16} />
				</span>
			}
		>
			<div className="kp-agent-chat__inspector-content">
				{widget ? <HarnessWidget lines={widget} /> : null}
				<AgentActivity assistantText={assistantText} activities={activities} />
			</div>
		</Collapsible>
	) : (
		<AgentActivity assistantText={assistantText} activities={activities} />
	);
}
