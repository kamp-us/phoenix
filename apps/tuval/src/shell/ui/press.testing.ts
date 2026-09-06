/**
 * A kernel behind a desk, for a test that is not about the round trip — the same shape
 * `./dom.testing.ts` has, and shipped beside the code for the same reason: a test double for one
 * seam belongs next to the seam.
 *
 * It folds the real reducer and answers as the acknowledgement does, at once. A test that types
 * faster than the kernel answers holds the answers itself (`./desk.unit.test.tsx`); this one is for
 * the desks whose subject is something else and which still need their keys to work.
 */

import {useRef, useState} from "react";
import type {ShellMsg, ShellState} from "../core/index.ts";
import {applyMsg} from "../core/index.ts";
import type {PrefixTable} from "../keys/index.ts";
import type {KeyPress} from "./press.ts";
import {replyIn} from "./press.ts";

export interface TestKernel {
	readonly state: ShellState;
	readonly dispatch: (msg: ShellMsg) => void;
	readonly press: KeyPress;
}

export const useTestKernel = (table: PrefixTable, initial: ShellState): TestKernel => {
	const [state, setState] = useState(initial);
	const held = useRef(initial);
	const presses = useRef(0);

	const fold = (msg: ShellMsg): ShellState => {
		const [next] = applyMsg(table, held.current, msg);
		held.current = next;
		setState(next);
		return next;
	};

	return {
		state,
		dispatch: (msg) => void fold(msg),
		press: (key) => {
			presses.current += 1;
			const pressId = `test-${presses.current}`;
			return Promise.resolve(replyIn(pressId, fold({type: "keys.press", key, pressId})));
		},
	};
};
