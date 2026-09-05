/**
 * The command line — the `:` prompt. It parses nothing: `readCommandLine` (`../commands/line.ts`)
 * reads the typed line against the shell's own command rows and answers a Msg or a typed refusal,
 * so there is no second dispatch beside the registry (ADR 0348, `.patterns/tuval-spells.md`).
 *
 * The input is the desk's one exception to "nothing else listens to the keyboard": it is a text
 * field, and a text field that did not read its own keys would be unusable. The desk's listener
 * stands down while this is open (`./Desk.tsx`), so no press is read twice — Escape and Enter are
 * this element's, everything else is text.
 */

import type {FormEvent, KeyboardEvent, ReactElement} from "react";
import {useEffect, useRef, useState} from "react";
import {readCommandLine, refusalMessage} from "../commands/index.ts";
import type {ShellMsg} from "../core/index.ts";

export interface CommandLineProps {
	readonly dispatch: (msg: ShellMsg) => void;
	/** Close the prompt and hand focus back to the desk. Called on Escape and on a read line. */
	readonly onClose: () => void;
}

export function CommandLine({dispatch, onClose}: CommandLineProps): ReactElement {
	const [line, setLine] = useState("");
	const [refusal, setRefusal] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);

	// The prompt opens because a key asked for it, so the caret belongs here the moment it exists;
	// `./Desk.tsx` returns focus to the desk when it closes.
	useEffect(() => {
		input.current?.focus();
	}, []);

	const submit = (event: FormEvent): void => {
		event.preventDefault();
		const answer = readCommandLine(line);
		if (answer._tag === "Refused") {
			setRefusal(refusalMessage(answer.refusal));
			return;
		}
		dispatch(answer.msg);
		onClose();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		onClose();
	};

	return (
		<form className="tuval-command-line" onSubmit={submit} aria-label="Command line">
			<label htmlFor="tuval-command-input" aria-hidden="true">
				:
			</label>
			<input
				id="tuval-command-input"
				ref={input}
				type="text"
				value={line}
				autoComplete="off"
				spellCheck={false}
				placeholder="workspace:create"
				aria-label="Type a command"
				aria-describedby={refusal === null ? undefined : "tuval-command-refusal"}
				aria-invalid={refusal !== null}
				onChange={(event) => {
					setLine(event.target.value);
					setRefusal(null);
				}}
				onKeyDown={onKeyDown}
			/>
			<p className="tuval-refusal" id="tuval-command-refusal" role="alert" aria-live="assertive">
				{refusal ?? ""}
			</p>
		</form>
	);
}
