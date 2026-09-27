/**
 * Questions the kernel waits on the person at the desk to answer: "Trust this folder?" (#9693) and
 * "<project> recommends <package>. Install?" (#9695). An asker waits; every attached page is sent
 * the waiting questions; a page's answer ends the wait.
 *
 * A question outlives no one waiting on it: an asker interrupted while it waits takes its question
 * back off every page.
 */

import {randomUUID} from "node:crypto";
import {Deferred, Effect, Stream, SubscriptionRef} from "effect";

export interface Questions<P extends {readonly question: string}, A> {
	/** Ask the question `prompt` builds around its fresh id, and wait for the person's answer. */
	readonly ask: (prompt: (question: string) => P) => Effect.Effect<A>;
	/**
	 * Answer one waiting question. `false` when nobody is waiting on it any more: a second page
	 * answering the same question, or an answer that arrived after its asker was interrupted.
	 */
	readonly answer: (question: string, answer: A) => Effect.Effect<boolean>;
	/** The waiting questions now, then after every question asked or answered, oldest first. */
	readonly pending: Stream.Stream<ReadonlyArray<P>>;
}

interface Waiting<P, A> {
	readonly prompt: P;
	readonly answered: Deferred.Deferred<A>;
}

export const makeQuestions = <P extends {readonly question: string}, A>() =>
	Effect.gen(function* () {
		const waiting = yield* SubscriptionRef.make<ReadonlyArray<Waiting<P, A>>>([]);

		const withdraw = (question: string) =>
			SubscriptionRef.update(waiting, (all) =>
				all.filter((one) => one.prompt.question !== question),
			);

		const ask = (prompt: (question: string) => P) =>
			Effect.acquireUseRelease(
				Effect.gen(function* () {
					const one: Waiting<P, A> = {
						prompt: prompt(randomUUID()),
						answered: yield* Deferred.make<A>(),
					};
					yield* SubscriptionRef.update(waiting, (all) => [...all, one]);
					return one;
				}),
				(one) => Deferred.await(one.answered),
				(one) => withdraw(one.prompt.question),
			);

		const answer = (question: string, given: A) =>
			Effect.flatMap(SubscriptionRef.get(waiting), (all) => {
				const one = all.find((candidate) => candidate.prompt.question === question);
				return one === undefined ? Effect.succeed(false) : Deferred.succeed(one.answered, given);
			});

		return {
			ask,
			answer,
			pending: Stream.map(SubscriptionRef.changes(waiting), (all) => all.map((one) => one.prompt)),
		} satisfies Questions<P, A>;
	});
