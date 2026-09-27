/**
 * `one-counter`'s row planned as node `main`, beside a copy built for an SDK major this desk does
 * not run, planned as node `later` (#9686): a desk booting this runs `main` and refuses `later`.
 */
import type {AnyProgram} from "@kampus/tuval-sdk/kernel/registry/program";
import {ProgramId} from "@kampus/tuval-sdk/kernel/registry/program";
import oneCounter from "./one-counter.ts";

const [counter] = oneCounter.programs;
if (counter === undefined) throw new Error("one-counter declares no row");

const programs: ReadonlyArray<AnyProgram> = [
	counter,
	{...counter, id: ProgramId.make("future-counter"), sdk: ">=1.0.0"},
];

export default {
	version: 1,
	programs,
	graph: {
		nodes: [
			{id: "main", program: "counter", on: []},
			{id: "later", program: "future-counter", on: []},
		],
	},
};
