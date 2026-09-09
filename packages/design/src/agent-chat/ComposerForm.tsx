import type {ReactNode} from "react";
import {Form} from "../Form";
import {useAgentChatInput} from "./Root";

/**
 * The form the field and the toolbar sit in. A host composing the parts by hand would otherwise
 * have to reach into the context for `submit` from outside the Root that provides it.
 */
export function AgentChatForm({children}: {readonly children: ReactNode}) {
	const {submit} = useAgentChatInput();

	return (
		<Form
			className="kp-agent-chat__form"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			{children}
		</Form>
	);
}
