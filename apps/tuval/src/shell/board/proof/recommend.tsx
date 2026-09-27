/**
 * "Install <package>?" in a real browser, without a kernel or a socket (#9695, ruling #9668 R6.2).
 * The page the design gate captures for the recommended-package question, beside the trust page, and
 * the page to open by hand to check what jsdom cannot: where focus lands as the dialog opens, as the
 * notice replaces the question after a yes, and when the dialog closes.
 *
 * Two packages are waiting as the page loads, so the capture shows the question, the package name
 * and the note that one more is waiting. Each answer is written to the page's log line; once both
 * are answered, "Ask again" puts both questions back.
 */

import {Button} from "@kampus/design";
import {StrictMode, useState} from "react";
import {createRoot} from "react-dom/client";
import {RecommendDialog} from "../../../page/RecommendDialog.tsx";
import type {RecommendAnswer, RecommendPrompt} from "../../../projects/recommend-prompt.ts";
import "../../../page/styles.ts";
import "./proof.css";

const folder = "/Users/ada/code/github.com/kamp-us/demlik";
const waiting: ReadonlyArray<RecommendPrompt> = [
	{question: "r-worktree", folder, name: "demlik", package: "@kampus/tuval-worktree"},
	{question: "r-cron", folder, name: "demlik", package: "@kampus/tuval-cron"},
];

function RecommendProof() {
	const [prompts, setPrompts] = useState(waiting);
	const [answers, setAnswers] = useState<ReadonlyArray<string>>([]);
	const answer = (question: string, given: RecommendAnswer) => {
		const pkg = prompts.find((prompt) => prompt.question === question)?.package ?? question;
		setAnswers((current) => [...current, `${pkg}: ${given}`]);
		setPrompts((current) => current.filter((prompt) => prompt.question !== question));
	};
	return (
		<div className="tuval-surface proof-desk proof-trust" data-scheme="dark">
			<p className="proof-desk-note" role="status">
				{answers.length === 0 ? "No package answered yet." : `Answered: ${answers.join(", ")}`}
			</p>
			<Button type="button" variant="secondary" onClick={() => setPrompts(waiting)}>
				Ask again
			</Button>
			<RecommendDialog prompts={prompts} onAnswer={answer} />
		</div>
	);
}

const host = document.getElementById("proof");
if (host === null) throw new Error("the proof page has no #proof element");

createRoot(host).render(
	<StrictMode>
		<RecommendProof />
	</StrictMode>,
);
