import {File as FileIcon, Terminal} from "lucide-react";
import {Button} from "../Button";
import {Icon} from "./Icon";
import type {Suggestion} from "./types";
import "./SuggestionRow.css";

export function SuggestionRow({
	id,
	suggestion,
	active,
	onSelect,
}: {
	readonly id: string;
	readonly suggestion: Suggestion;
	readonly active: boolean;
	readonly onSelect: () => void;
}) {
	const command = suggestion.kind === "command" ? suggestion.command : undefined;
	return (
		<Button
			id={id}
			type="button"
			variant="tertiary"
			block
			className="kp-agent-chat__suggestion"
			role="option"
			aria-selected={active}
			onClick={onSelect}
		>
			<Icon icon={suggestion.kind === "command" ? Terminal : FileIcon} size={16} />
			<span className="kp-agent-chat__suggestion-main">
				{suggestion.kind === "command" ? `/${command?.name ?? ""}` : `@${suggestion.path}`}
			</span>
			{command?.description ? (
				<span className="kp-agent-chat__suggestion-detail">{command.description}</span>
			) : null}
		</Button>
	);
}
