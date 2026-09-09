import type {ReactNode} from "react";
import {useDesignT} from "../i18n";
import {AgentChatPickers} from "./Pickers";
import {useAgentChatInput} from "./Root";

/**
 * The composer's settings fieldset.
 *
 * With no children it renders the rows this composer owns (`Pickers`) followed by the host's
 * `settings` slot, which is what the exported composer assembles. Children replace both, for a
 * host that wants the fieldset with a row set of its own — a host that wants the owned rows *and*
 * one of its own puts `Pickers` in those children beside it.
 */
export function AgentChatSettings({children}: {readonly children?: ReactNode}) {
	const {settings} = useAgentChatInput();
	const t = useDesignT();

	return (
		<fieldset className="kp-agent-chat__settings">
			<legend className="kp-visually-hidden">{t("admin.agent.settings")}</legend>
			{children ?? (
				<>
					<AgentChatPickers />
					{settings}
				</>
			)}
		</fieldset>
	);
}
