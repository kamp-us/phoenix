/** The `:` prompt: shell rows dispatch locally; registered commands call the attached kernel. */

import {Effect, Fiber} from "effect";
import type {FormEvent, KeyboardEvent, ReactElement} from "react";
import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {buildSpellIndex} from "../../commands/parse/spell-index.ts";
import {CallId, type WindowId} from "../../protocol/ids.ts";
import type {Snapshot} from "../../protocol/messages.ts";
import type {RegistryDescription} from "../../protocol/registry-description.ts";
import type {CommandIndex} from "../commands/index.ts";
import {readCommandLine, refusalMessage} from "../commands/index.ts";
import type {ShellMsg} from "../core/index.ts";
import type {PageAttachment} from "../transport/browser.ts";

export interface CommandLineProps {
	readonly dispatch: (msg: ShellMsg) => void;
	/** Close the prompt and hand focus back to the desk. Called on Escape and on a read line. */
	readonly onClose: () => void;
	readonly registry?: RegistryDescription | undefined;
	readonly snapshot?: Snapshot | undefined;
	readonly call?: PageAttachment["call"] | undefined;
	readonly window?: WindowId | undefined;
	/**
	 * The rows this line may name. Absent is the ungated table; a desk with feature flags resolved
	 * passes the gated index, so a row a flag turned off is as unreadable here as it is unbindable.
	 */
	readonly commands?: CommandIndex | undefined;
}

export function CommandLine({
	dispatch,
	onClose,
	registry,
	snapshot,
	call,
	window,
	commands,
}: CommandLineProps): ReactElement {
	const [line, setLine] = useState("");
	const [refusal, setRefusal] = useState<string | null>(null);
	const [output, setOutput] = useState<string | null>(null);
	const index = useMemo(
		() => (registry === undefined ? null : buildSpellIndex(registry)),
		[registry],
	);
	const request = useRef(0);
	const pending = useRef(false);
	const running = useRef<Fiber.Fiber<unknown> | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const currentCall = useRef(call);
	currentCall.current = call;
	const invalidate = useCallback(() => {
		request.current += 1;
		pending.current = false;
		if (running.current !== null) Effect.runFork(Fiber.interrupt(running.current));
		running.current = null;
	}, []);
	useEffect(() => {
		invalidate();
		setOutput(null);
		setRefusal(null);
		return invalidate;
	}, [call, invalidate]);

	// The prompt opens because a key asked for it, so the caret belongs here the moment it exists;
	// `./Desk.tsx` returns focus to the desk when it closes.
	useEffect(() => {
		input.current?.focus();
	}, []);

	const submit = (event: FormEvent): void => {
		event.preventDefault();
		if (pending.current) return;
		const answer =
			index === null || snapshot === undefined
				? readCommandLine(line, {commands})
				: readCommandLine(line, {
						registry: index,
						snapshot,
						id: CallId.make(crypto.randomUUID()),
						window,
						commands,
					});
		setOutput(null);
		if (answer._tag === "Refused") {
			setRefusal(refusalMessage(answer.refusal));
			return;
		}
		if (answer._tag === "Spell") {
			if (call === undefined) {
				setRefusal("Disconnected: this command line has no kernel to call.");
				return;
			}
			invalidate();
			const ticket = request.current;
			pending.current = true;
			setRefusal(null);
			setOutput("Running…");
			const accept = (write: () => void) =>
				Effect.sync(() => {
					if (ticket !== request.current || currentCall.current !== call) return;
					pending.current = false;
					write();
				});
			running.current = Effect.runFork(
				call(answer.call).pipe(
					Effect.flatMap((reply) =>
						accept(() => {
							if (reply.ok)
								setOutput(
									reply.result === undefined ? "Completed." : JSON.stringify(reply.result, null, 2),
								);
							else {
								setOutput(null);
								setRefusal(
									`${reply.error.tag}: ${reply.error.message}${reply.error.didYouMean === undefined ? "" : ` Did you mean "${reply.error.didYouMean}"?`}`,
								);
							}
						}),
					),
					Effect.catch(() =>
						accept(() => {
							setOutput(null);
							setRefusal("Disconnected: the desk lost its link to the kernel.");
						}),
					),
				),
			);
			return;
		}
		dispatch(answer.msg);
		onClose();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		invalidate();
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
					invalidate();
					setLine(event.target.value);
					setRefusal(null);
					setOutput(null);
				}}
				onKeyDown={onKeyDown}
			/>
			<p className="tuval-refusal" id="tuval-command-refusal" role="alert" aria-live="assertive">
				{refusal ?? ""}
			</p>
			{output === null ? null : (
				<pre className="tuval-command-result" role="status" aria-live="polite">
					{output}
				</pre>
			)}
		</form>
	);
}
