import {useEffect, useRef, useState} from "react";

/**
 * Pulses `flashing` true for one animation cycle whenever `score` changes — the
 * count-flash retrigger for the vote controls (#1213). Stays false on first
 * render (no flash on initial paint) and re-arms on every later change. Pair
 * with `onAnimationEnd={endFlash}` on the animated element so the class clears
 * and the next cast can replay it.
 */
export function useVoteFlash(score: number): {flashing: boolean; endFlash: () => void} {
	const [flashing, setFlashing] = useState(false);
	const prev = useRef(score);

	useEffect(() => {
		if (prev.current !== score) {
			prev.current = score;
			setFlashing(true);
		}
	}, [score]);

	return {flashing, endFlash: () => setFlashing(false)};
}
