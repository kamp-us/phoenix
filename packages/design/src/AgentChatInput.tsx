import {ChevronDown, ChevronUp} from "lucide-react";
import {Alert} from "./Alert";
import {AgentActivity} from "./agent-chat/AgentActivity";
import {AgentChatControl} from "./agent-chat/Control";
import {AgentChatField} from "./agent-chat/Field";
import {HarnessWidget} from "./agent-chat/HarnessWidget";
import {AgentChatHint} from "./agent-chat/Hint";
import {Icon} from "./agent-chat/Icon";
import {PiExtensionDialog} from "./agent-chat/PiExtensionDialog";
import {type AgentChatInputProps, AgentChatInputRoot, useAgentChatInput} from "./agent-chat/Root";
import {AgentChatSettings} from "./agent-chat/Settings";
import {AgentChatSurface} from "./agent-chat/Surface";
import {AgentChatToolbar} from "./agent-chat/Toolbar";
import {Collapsible} from "./Collapsible";
import {Form} from "./Form";
import {useDesignT} from "./i18n";
import "./AgentChatInput.css";
import "./visually-hidden.css";

export type {AgentChatInputProps} from "./agent-chat/Root";

function AgentChatInputBody() {
	const {
		variant,
		error,
		assistantText,
		activities,
		extension,
		widget,
		inspectorOpen,
		setInspectorOpen,
		submit,
		answerExtension,
	} = useAgentChatInput();
	const t = useDesignT();

	return (
		<section
			className={`kp-agent-chat kp-agent-chat--${variant}`}
			aria-label={t("admin.agent.label")}
		>
			{variant === "harness" && widget ? <HarnessWidget lines={widget} /> : null}
			<AgentChatSurface>
				<Form
					className="kp-agent-chat__form"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<AgentChatField />
					<AgentChatToolbar />
				</Form>

				<AgentChatHint />
				{error ? (
					<Alert className="kp-agent-chat__error" variant="danger">
						{error}
					</Alert>
				) : null}
			</AgentChatSurface>

			{variant === "focused" ? (
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
			)}
			{extension ? <PiExtensionDialog request={extension} onAnswer={answerExtension} /> : null}
		</section>
	);
}

export function AgentChatInput(props: AgentChatInputProps) {
	return (
		<AgentChatInputRoot {...props}>
			<AgentChatInputBody />
		</AgentChatInputRoot>
	);
}

AgentChatInput.Root = AgentChatInputRoot;
AgentChatInput.Surface = AgentChatSurface;
AgentChatInput.Field = AgentChatField;
AgentChatInput.Toolbar = AgentChatToolbar;
AgentChatInput.Settings = AgentChatSettings;
AgentChatInput.Hint = AgentChatHint;
AgentChatInput.Control = AgentChatControl;
