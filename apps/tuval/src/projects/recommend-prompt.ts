/**
 * "<project> recommends <package>. Install?" as the page reads it (#9695). It imports nothing from
 * Node, because the page imports it; the kernel half that asks and waits is `./RecommendPrompts.ts`.
 */

/** One recommended package waiting on the person at the desk. */
export interface RecommendPrompt {
	/** Which question an answer is for: several packages, and several projects, wait at once. */
	readonly question: string;
	/** The project's folder, absolute, which the answer is remembered for. */
	readonly folder: string;
	/** The project's label, for the heading a person reads first. */
	readonly name: string;
	/** The npm package the project recommends. */
	readonly package: string;
}

/**
 * Install or decline. Either answer is remembered for the project, so it is asked once. Nothing is
 * installed on either one: the installer is a later spec, so `install` is recorded as intent only.
 */
export type RecommendAnswer = "install" | "decline";
