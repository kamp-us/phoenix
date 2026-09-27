/**
 * "Trust this folder?" in a real browser, without a kernel or a socket (#9693, ruling #9668 R2.1).
 * The page the design gate captures for the trust question, beside the board's own pages, and the
 * page to open by hand to check what jsdom cannot: where focus lands when the dialog opens, and
 * that it goes back to what held it when the dialog closes.
 *
 * Two folders are waiting as the page loads, so the capture shows the question, the whole folder
 * path and the note that one more folder is waiting behind it. Each answer is written to the page's
 * log line; once both are answered, "Ask again" puts both questions back, and closing the dialog then
 * returns focus to that button.
 */

import {Button} from "@kampus/design";
import {StrictMode, useState} from "react";
import {createRoot} from "react-dom/client";
import {TrustFolderDialog} from "../../../page/TrustFolderDialog.tsx";
import type {TrustAnswer, TrustPrompt} from "../../../projects/trust-prompt.ts";
import "../../../page/styles.ts";
import "./proof.css";

const waiting: ReadonlyArray<TrustPrompt> = [
	{question: "q-demlik", folder: "/Users/ada/code/github.com/kamp-us/demlik", name: "demlik"},
	{question: "q-tea", folder: "/Users/ada/code/github.com/kamp-us/tea", name: "tea"},
];

function TrustProof() {
	const [prompts, setPrompts] = useState(waiting);
	const [answers, setAnswers] = useState<ReadonlyArray<string>>([]);
	const answer = (question: string, given: TrustAnswer) => {
		const folder = prompts.find((prompt) => prompt.question === question)?.name ?? question;
		setAnswers((current) => [...current, `${folder}: ${given}`]);
		setPrompts((current) => current.filter((prompt) => prompt.question !== question));
	};
	return (
		<div className="tuval-surface proof-desk proof-trust" data-scheme="dark">
			<p className="proof-desk-note" role="status">
				{answers.length === 0 ? "No folder answered yet." : `Answered: ${answers.join(", ")}`}
			</p>
			<Button type="button" variant="secondary" onClick={() => setPrompts(waiting)}>
				Ask again
			</Button>
			<TrustFolderDialog prompts={prompts} onAnswer={answer} />
		</div>
	);
}

const host = document.getElementById("proof");
if (host === null) throw new Error("the proof page has no #proof element");

createRoot(host).render(
	<StrictMode>
		<TrustProof />
	</StrictMode>,
);
