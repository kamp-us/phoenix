/**
 * What the person at the desk answered about each project's recommended packages (#9695, ruling
 * #9668 R6.2). A project config lists `recommends`; the desk asks about each package once, and the
 * answer is remembered for that project so it is never asked again. Nothing is installed on any
 * answer: an `install` is the person's recorded intent, which the installer (a later spec) reads.
 *
 * Answers are kept per folder under the ADR 0402 path key (`../project-id.ts`), like trust, so two
 * spellings of one folder share their answers, and they outlive the project closing.
 */

import {resolve} from "node:path";
import {ProjectId} from "../project-id.ts";
import type {RecommendAnswer} from "./recommend-prompt.ts";

const keyOf = (folder: string): string => ProjectId.of(resolve(folder)).key;

/** One folder's answers as the saved list writes them: package name to answer. */
export interface FolderAnswers {
	readonly folder: string;
	readonly answers: Readonly<Record<string, RecommendAnswer>>;
}

interface Answered {
	readonly folder: string;
	readonly answers: ReadonlyMap<string, RecommendAnswer>;
}

export class RecommendAnswers {
	static readonly none = new RecommendAnswers(new Map());

	/** Keyed by the folder's path key; each keeps the folder as it was first answered for. */
	private readonly byKey: ReadonlyMap<string, Answered>;

	private constructor(byKey: ReadonlyMap<string, Answered>) {
		this.byKey = byKey;
	}

	/** The answers a saved list holds, a folder listed twice under two spellings merged. */
	static of(saved: Iterable<FolderAnswers>): RecommendAnswers {
		let all = RecommendAnswers.none;
		for (const {folder, answers} of saved) {
			for (const [pkg, answer] of Object.entries(answers)) all = all.answer(folder, pkg, answer);
		}
		return all;
	}

	/** What the person answered about `pkg` for the project at `folder`, if they were asked. */
	answerFor(folder: string, pkg: string): RecommendAnswer | undefined {
		return this.byKey.get(keyOf(folder))?.answers.get(pkg);
	}

	/** The packages of `recommends` still to ask about for the project at `folder`, in its order. */
	unasked(folder: string, recommends: ReadonlyArray<string>): ReadonlyArray<string> {
		return [...new Set(recommends)].filter((pkg) => this.answerFor(folder, pkg) === undefined);
	}

	/** The same answers, with `answer` remembered for `pkg` in the project at `folder`. */
	answer(folder: string, pkg: string, answer: RecommendAnswer): RecommendAnswers {
		if (this.answerFor(folder, pkg) === answer) return this;
		const key = keyOf(folder);
		const current = this.byKey.get(key);
		const answers = new Map(current?.answers);
		answers.set(pkg, answer);
		const byKey = new Map(this.byKey);
		byKey.set(key, {folder: current?.folder ?? resolve(folder), answers});
		return new RecommendAnswers(byKey);
	}

	/** Every folder with an answer, in the order each was first answered for. */
	get record(): ReadonlyArray<FolderAnswers> {
		return [...this.byKey.values()].map(({folder, answers}) => ({
			folder,
			answers: Object.fromEntries(answers),
		}));
	}
}
