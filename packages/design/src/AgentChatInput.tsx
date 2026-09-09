import {AgentChatAttach} from "./agent-chat/Attach";
import {AgentChatForm} from "./agent-chat/ComposerForm";
import {AgentChatControl} from "./agent-chat/Control";
import {AgentChatError} from "./agent-chat/ErrorAlert";
import {AgentChatExtensionDialog} from "./agent-chat/ExtensionDialog";
import {AgentChatField} from "./agent-chat/Field";
import {AgentChatFrame} from "./agent-chat/Frame";
import {AgentChatHint} from "./agent-chat/Hint";
import {AgentChatInspector} from "./agent-chat/Inspector";
import {AgentChatOverflow} from "./agent-chat/Overflow";
import {AgentChatPickers} from "./agent-chat/Pickers";
import {AgentChatPrimaryActions} from "./agent-chat/PrimaryActions";
import {type AgentChatInputProps, AgentChatInputRoot} from "./agent-chat/Root";
import {AgentChatSettings} from "./agent-chat/Settings";
import {AgentChatSurface} from "./agent-chat/Surface";
import {AgentChatToolbar} from "./agent-chat/Toolbar";
import "./AgentChatInput.css";
import "./visually-hidden.css";

export type {AgentChatInputProps} from "./agent-chat/Root";

function AgentChatInputBody() {
	return (
		<AgentChatFrame>
			<AgentChatSurface>
				<AgentChatForm>
					<AgentChatField />
					<AgentChatToolbar />
				</AgentChatForm>

				<AgentChatHint />
				<AgentChatError />
			</AgentChatSurface>

			<AgentChatInspector />
			<AgentChatExtensionDialog />
		</AgentChatFrame>
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
AgentChatInput.Frame = AgentChatFrame;
AgentChatInput.Surface = AgentChatSurface;
AgentChatInput.Form = AgentChatForm;
AgentChatInput.Field = AgentChatField;
AgentChatInput.Toolbar = AgentChatToolbar;
AgentChatInput.Attach = AgentChatAttach;
AgentChatInput.Settings = AgentChatSettings;
AgentChatInput.Pickers = AgentChatPickers;
AgentChatInput.Hint = AgentChatHint;
AgentChatInput.Error = AgentChatError;
AgentChatInput.Control = AgentChatControl;
AgentChatInput.PrimaryActions = AgentChatPrimaryActions;
AgentChatInput.Overflow = AgentChatOverflow;
AgentChatInput.Inspector = AgentChatInspector;
AgentChatInput.ExtensionDialog = AgentChatExtensionDialog;
