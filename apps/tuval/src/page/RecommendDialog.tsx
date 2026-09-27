/**
 * "Install <package>?", asked when a trusted project recommends a package nobody has answered about
 * for it (#9695, ruling #9668 R6.2). The kernel holds the question (`../projects/RecommendPrompts.ts`);
 * this page shows the oldest waiting one and sends the person's answer back.
 *
 * **The dialog is `@kampus/design`'s**, an `alertdialog` named by its title, like the trust question
 * (`./TrustFolderDialog.tsx`): the focus trap, Escape and the return of focus are the shared
 * component's.
 *
 * **Nothing installs.** The installer is a later spec, so "Install" records the person's intent and
 * the dialog then says plainly that installing is not available yet, rather than pretending it
 * worked. That notice stays until the person closes it, and the next question waits behind it.
 *
 * **A no is remembered, and so is a dismissal.** Escape answers "Don't install", the same as every
 * other way out of a desk question, and focus opens on "Don't install" so an Enter pressed before
 * reading never says yes. A click outside does not answer at all.
 */

import {Button, Dialog} from "@kampus/design";
import {type ReactElement, useEffect, useId, useRef, useState} from "react";
import type {RecommendAnswer, RecommendPrompt} from "../projects/recommend-prompt.ts";
import "./recommend-dialog.css";

export interface RecommendDialogProps {
	/** Every recommended package a project is waiting on, oldest first. The dialog shows the first. */
	readonly prompts: ReadonlyArray<RecommendPrompt>;
	readonly onAnswer: (question: string, answer: RecommendAnswer) => void;
}

/** The package the person said yes to, shown until they close the notice. */
interface Wanted {
	readonly name: string;
	readonly package: string;
}

const waitingLine = (count: number): string =>
	count === 1
		? "1 more recommended package is waiting."
		: `${count} more recommended packages are waiting.`;

export function RecommendDialog({prompts, onAnswer}: RecommendDialogProps): ReactElement | null {
	const [wanted, setWanted] = useState<Wanted | null>(null);
	const [current, ...rest] = prompts;
	const declineId = useId();
	const closeId = useId();
	// What the dialog shows now: a notice, a question, or nothing. Focus moves when it changes
	// while the dialog stays open, because the dialog's own autofocus runs only as it opens.
	const showing = wanted !== null ? `wanted:${wanted.package}` : current?.question;
	const shown = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (shown.current !== undefined && showing !== undefined && showing !== shown.current) {
			document.getElementById(wanted !== null ? closeId : declineId)?.focus();
		}
		shown.current = showing;
	}, [showing, wanted, closeId, declineId]);

	if (wanted !== null) {
		return (
			<Dialog
				open
				role="alertdialog"
				title="Installing is not available yet"
				description={`Nothing was installed. Your yes to ${wanted.package} is saved for ${wanted.name}, so the desk will not ask about it again.`}
				showCloseButton={false}
				closeOnInteractOutside={false}
				onOpenChange={(next) => {
					if (!next) setWanted(null);
				}}
				className="tuval-recommend-dialog"
				footer={() => (
					<Button
						id={closeId}
						type="button"
						variant="primary"
						data-autofocus=""
						onClick={() => setWanted(null)}
					>
						OK
					</Button>
				)}
			>
				{prompts.length > 0 ? (
					<p className="tuval-recommend-waiting">{waitingLine(prompts.length)}</p>
				) : null}
			</Dialog>
		);
	}

	if (current === undefined) return null;
	const answer = (given: RecommendAnswer) => {
		if (given === "install") setWanted({name: current.name, package: current.package});
		onAnswer(current.question, given);
	};
	return (
		<Dialog
			open
			role="alertdialog"
			title={`Install ${current.package}?`}
			description={`${current.name} recommends this package in its .tuval config. The desk never installs anything without asking.`}
			showCloseButton={false}
			closeOnInteractOutside={false}
			onOpenChange={(next) => {
				if (!next) answer("decline");
			}}
			className="tuval-recommend-dialog"
			footer={() => (
				<>
					<Button
						id={declineId}
						type="button"
						variant="secondary"
						data-autofocus=""
						onClick={() => answer("decline")}
					>
						Don't install
					</Button>
					<Button type="button" variant="primary" onClick={() => answer("install")}>
						Install
					</Button>
				</>
			)}
		>
			<div className="tuval-recommend-body">
				<p className="tuval-recommend-note">
					Either answer is remembered for {current.name}, so you are asked about this package once.
				</p>
				{rest.length > 0 ? (
					<p className="tuval-recommend-waiting">{waitingLine(rest.length)}</p>
				) : null}
			</div>
		</Dialog>
	);
}
