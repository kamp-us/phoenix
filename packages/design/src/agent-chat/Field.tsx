import {FileImage, X} from "lucide-react";
import {Card} from "../Card";
import {Textarea} from "../Form";
import {useDesignT} from "../i18n";
import {AgentChatControl} from "./Control";
import {Icon} from "./Icon";
import {useAgentChatInput} from "./Root";
import {SuggestionRow} from "./SuggestionRow";

/**
 * What the operator types into: the attachments they have queued, the prompt textarea, and the
 * completion listbox the textarea's combobox contract points at.
 *
 * The `role="combobox"` on the textarea is what axe reports as disallowed (#7876). It stays as it
 * is here; changing it is that ticket's.
 */
export function AgentChatField() {
	const {
		disabled,
		fieldRef,
		inputId,
		suggestionsId,
		draft,
		images,
		suggestions,
		activeSuggestion,
		activeSuggestionId,
		typeDraft,
		selectSuggestion,
		removeImage,
		onPaste,
		onKeyDown,
	} = useAgentChatInput();
	const t = useDesignT();

	return (
		<>
			{images.length > 0 ? (
				<ul className="kp-agent-chat__attachments" aria-label={t("admin.agent.attachments")}>
					{images.map((image) => (
						<li key={image.name} className="kp-agent-chat__attachment">
							<Icon icon={FileImage} size={16} />
							<span>{image.name}</span>
							<AgentChatControl
								icon={X}
								className="kp-agent-chat__attachment-remove"
								onClick={() => removeImage(image)}
							>
								<span className="kp-visually-hidden">
									{t("admin.agent.attachment.remove", {name: image.name})}
								</span>
							</AgentChatControl>
						</li>
					))}
				</ul>
			) : null}

			<div className="kp-agent-chat__field">
				<Textarea
					ref={fieldRef}
					id={inputId}
					className="kp-agent-chat__textarea"
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={suggestions.length > 0}
					aria-controls={suggestions.length > 0 ? suggestionsId : undefined}
					aria-activedescendant={activeSuggestionId}
					label={<span className="kp-visually-hidden">{t("admin.agent.compose.label")}</span>}
					placeholder={t("admin.agent.compose.placeholder")}
					value={draft}
					onChange={(event) => typeDraft(event.currentTarget.value)}
					onPaste={onPaste}
					onKeyDown={onKeyDown}
					rows={3}
					resize="none"
					spellCheck
					fullWidth
					disabled={disabled}
				/>
				{suggestions.length > 0 ? (
					<Card
						id={suggestionsId}
						className="kp-agent-chat__suggestions"
						role="listbox"
						aria-label={t("admin.agent.completions")}
					>
						{suggestions.map((suggestion, index) => (
							<SuggestionRow
								id={`${suggestionsId}-${index}`}
								key={suggestion.kind === "command" ? suggestion.command.name : suggestion.path}
								suggestion={suggestion}
								active={index === activeSuggestion}
								onSelect={() => selectSuggestion(suggestion)}
							/>
						))}
					</Card>
				) : null}
			</div>
		</>
	);
}
