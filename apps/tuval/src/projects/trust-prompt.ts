/**
 * The "Trust this folder?" question as the page reads it (#9693). It imports nothing from Node,
 * because the page imports it; the kernel half that asks and waits is `./TrustPrompts.ts`.
 */

/** One folder waiting on the person at the desk. */
export interface TrustPrompt {
	/** Which question an answer is for: two opens of two folders wait at once. */
	readonly question: string;
	/** The folder, absolute, as the desk will open it. */
	readonly folder: string;
	/** The folder's name, for the heading a person reads first. */
	readonly name: string;
}

/** Yes or no. There is no third answer, because there is no restricted mode (#9668 R2.1). */
export type TrustAnswer = "trust" | "refuse";
