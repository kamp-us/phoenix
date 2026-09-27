/**
 * The "<project> recommends <package>. Install?" questions a desk is waiting on (#9695, ruling
 * #9668 R6.2). A trusted project that opens with packages nobody has answered about asks here; every
 * attached page is sent the waiting questions and shows the first as a dialog; the person's answer
 * comes back from that page (`./questions.ts`).
 *
 * Like trust, the answer is a page's alone: it arrives on a transport frame only a desk page's socket
 * sends, never as a spell, so an agent cannot answer for the person.
 */

import {Context, Effect, Stream} from "effect";
import {makeQuestions} from "./questions.ts";
import type {RecommendAnswer, RecommendPrompt} from "./recommend-prompt.ts";

export class RecommendPrompts extends Context.Service<
	RecommendPrompts,
	{
		/** Ask whether to install `pkg`, which the project at `folder`, labelled `name`, recommends. */
		readonly ask: (folder: string, name: string, pkg: string) => Effect.Effect<RecommendAnswer>;
		/** Answer one waiting question; `false` when nobody is waiting on it any more. */
		readonly answer: (question: string, answer: RecommendAnswer) => Effect.Effect<boolean>;
		/** The waiting questions now, then after every question asked or answered, oldest first. */
		readonly pending: Stream.Stream<ReadonlyArray<RecommendPrompt>>;
	}
>()("tuval/RecommendPrompts") {
	/** A kernel with no desk: nothing opens a project, so nothing is ever asked. */
	static readonly none: RecommendPrompts["Service"] = RecommendPrompts.of({
		ask: () => Effect.never,
		answer: () => Effect.succeed(false),
		pending: Stream.make([]),
	});
}

export const makeRecommendPrompts = Effect.map(
	makeQuestions<RecommendPrompt, RecommendAnswer>(),
	(questions) =>
		RecommendPrompts.of({
			ask: (folder, name, pkg) =>
				questions.ask((question) => ({question, folder, name, package: pkg})),
			answer: questions.answer,
			pending: questions.pending,
		}),
);
