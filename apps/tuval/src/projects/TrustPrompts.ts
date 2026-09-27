/**
 * The "Trust this folder?" questions a desk is waiting on (#9693, ruling #9668 R2.1). An open that
 * needs trust asks here and waits; every attached page is sent the waiting questions and shows the
 * first one as a dialog; the person's answer comes back from that page and ends the wait
 * (`./questions.ts`).
 *
 * The answer is a page's alone. It arrives on a transport frame only a desk page's socket can send
 * (`../shell/transport/wire.ts`), never as a spell, because a spell is reachable by any agent whose
 * bridge allows every spell, and an agent that could open a folder and then answer for the person
 * would make the question worthless.
 */

import {Context, Effect, Stream} from "effect";
import {ProjectId} from "../project-id.ts";
import {makeQuestions} from "./questions.ts";
import type {TrustAnswer, TrustPrompt} from "./trust-prompt.ts";

export class TrustPrompts extends Context.Service<
	TrustPrompts,
	{
		/** Ask whether to trust `folder`, and wait for the person's answer. */
		readonly ask: (folder: string) => Effect.Effect<TrustAnswer>;
		/**
		 * Answer one waiting question. `false` when no open is waiting on it any more: a second page
		 * answering the same question, or an answer that arrived after its open was interrupted.
		 */
		readonly answer: (question: string, answer: TrustAnswer) => Effect.Effect<boolean>;
		/** The waiting questions now, then after every question asked or answered, oldest first. */
		readonly pending: Stream.Stream<ReadonlyArray<TrustPrompt>>;
	}
>()("tuval/TrustPrompts") {
	/** A kernel with no desk to ask from: nothing is ever asked, because nothing opens a folder. */
	static readonly none: TrustPrompts["Service"] = TrustPrompts.of({
		ask: () => Effect.succeed("refuse"),
		answer: () => Effect.succeed(false),
		pending: Stream.make([]),
	});
}

export const makeTrustPrompts = Effect.map(makeQuestions<TrustPrompt, TrustAnswer>(), (questions) =>
	TrustPrompts.of({
		ask: (folder) =>
			questions.ask((question) => ({question, folder, name: ProjectId.of(folder).name})),
		answer: questions.answer,
		pending: questions.pending,
	}),
);
