/**
 * "Trust this folder?", asked before anything from a folder with a `.tuval` config runs (#9693,
 * ruling #9668 R2.1). The kernel holds the question and waits on it (`../projects/TrustPrompts.ts`);
 * this page shows the oldest waiting one and sends the person's answer back.
 *
 * **The dialog is `@kampus/design`'s.** The focus trap, the return of focus to whatever held it
 * before the dialog opened, Escape and the `aria-modal` announcement are the shared component's, as
 * they are for the process board (`../shell/board/ProcessBoardOverlay.tsx`). It is an `alertdialog`,
 * because it interrupts to ask something that needs an answer, and its title is its accessible name.
 *
 * **Every way out is a no.** There is no restricted mode, so a person who dismisses the question
 * has not trusted the folder: Escape answers "Don't trust". A click outside does not answer at all,
 * because a stray click is not a decision. Focus opens on "Don't trust", so an Enter pressed before
 * reading runs nothing.
 *
 * **One dialog for every waiting folder, and none while nothing waits.** The next folder swaps in
 * under the same dialog, and focus goes back to "Don't trust" for it, so a yes given to one folder
 * is never one keypress from being given to the next. Once no folder is left the dialog unmounts:
 * a closed one left in the tree still sits in the shared layer stack and races the process board
 * for Escape.
 */

import {Button, Dialog} from "@kampus/design";
import {type ReactElement, useEffect, useId, useRef} from "react";
import type {TrustAnswer, TrustPrompt} from "../projects/trust-prompt.ts";
import "./trust-folder-dialog.css";

export interface TrustFolderDialogProps {
	/** Every question an open is waiting on, oldest first. The dialog shows the first. */
	readonly prompts: ReadonlyArray<TrustPrompt>;
	readonly onAnswer: (question: string, answer: TrustAnswer) => void;
}

const waitingLine = (count: number): string =>
	count === 1
		? "1 more folder is waiting to be asked about."
		: `${count} more folders are waiting to be asked about.`;

export function TrustFolderDialog({
	prompts,
	onAnswer,
}: TrustFolderDialogProps): ReactElement | null {
	const [current, ...rest] = prompts;
	const refuseId = useId();
	const asked = useRef<string | undefined>(undefined);
	const question = current?.question;
	useEffect(() => {
		// The first question's focus is the dialog's own, placed through `data-autofocus` as its trap
		// activates, which is also when it records where focus goes back to. Focusing here instead
		// would move focus into the dialog first and hand that return point to a button.
		if (asked.current !== undefined && question !== undefined && question !== asked.current) {
			document.getElementById(refuseId)?.focus();
		}
		asked.current = question;
	}, [question, refuseId]);

	if (current === undefined) return null;
	const answer = (given: TrustAnswer) => onAnswer(current.question, given);
	return (
		<Dialog
			open
			role="alertdialog"
			title="Trust this folder?"
			description={`Opening ${current.name} runs the programs its .tuval config declares, with your permissions. Trust only folders whose code you know.`}
			showCloseButton={false}
			closeOnInteractOutside={false}
			onOpenChange={(next) => {
				if (!next) answer("refuse");
			}}
			className="tuval-trust-dialog"
			footer={() => (
				<>
					<Button
						id={refuseId}
						type="button"
						variant="secondary"
						data-autofocus=""
						onClick={() => answer("refuse")}
					>
						Don't trust
					</Button>
					<Button type="button" variant="primary" onClick={() => answer("trust")}>
						Trust folder
					</Button>
				</>
			)}
		>
			<div className="tuval-trust-body">
				<code className="tuval-trust-folder">{current.folder}</code>
				<p className="tuval-trust-note">
					Don't trust it, and nothing from it runs. A yes is remembered for this folder.
				</p>
				{rest.length > 0 ? <p className="tuval-trust-waiting">{waitingLine(rest.length)}</p> : null}
			</div>
		</Dialog>
	);
}
