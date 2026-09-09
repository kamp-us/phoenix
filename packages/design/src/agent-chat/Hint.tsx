import {Kbd} from "../atoms";
import {useDesignT} from "../i18n";
import {useAgentChatInput} from "./Root";

/** The line under the composer naming what the field accepts. */
export function AgentChatHint() {
	const {variant, commands} = useAgentChatInput();
	const t = useDesignT();

	// A harness that offers no commands does not advertise the sigil: typing `/` against an empty
	// catalog opens nothing, and a hint promising a picker that never appears reads as a fault.
	const commandHint =
		commands.length > 0 ? (
			<>
				<Kbd>/</Kbd> {t("admin.agent.hint.command")} ·{" "}
			</>
		) : null;

	return variant === "harness" ? (
		<p className="kp-agent-chat__hint">
			<Kbd>Enter</Kbd> {t("admin.agent.hint.send")} · <Kbd>Shift+Enter</Kbd>{" "}
			{t("admin.agent.hint.newline")} · {commandHint}
			<Kbd>@</Kbd> {t("admin.agent.hint.file")} · {t("admin.agent.hint.pasteImage")}
		</p>
	) : (
		<p className="kp-agent-chat__hint">
			{commandHint}
			<Kbd>@</Kbd> {t("admin.agent.hint.file")} · {t("admin.agent.hint.addOrPasteImage")}
		</p>
	);
}
