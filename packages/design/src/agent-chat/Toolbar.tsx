import {Paperclip} from "lucide-react";
import {useRef} from "react";
import {Input} from "../Form";
import {useDesignT} from "../i18n";
import {AgentChatControl} from "./Control";
import {AgentChatOverflow} from "./Overflow";
import {AgentChatPrimaryActions} from "./PrimaryActions";
import {useAgentChatInput} from "./Root";
import {AgentChatSettings} from "./Settings";

/**
 * The control row under the field: what the operator can attach and configure on the left, and how
 * a draft leaves the composer on the right.
 */
export function AgentChatToolbar() {
	const {disabled, variant, addImage} = useAgentChatInput();
	const t = useDesignT();
	const imageInputRef = useRef<HTMLInputElement>(null);

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
				{variant === "focused" ? <AgentChatOverflow /> : null}
			</div>
			<AgentChatPrimaryActions />
		</div>
	);
}
