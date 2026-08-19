import {useEffect, useRef, useState} from "react";

/**
 * Pulses `flashing` for one animation cycle on every `score` change after the first
 * render. Pair with `onAnimationEnd={endFlash}` on the animated element, or the class
 * never clears and the next cast cannot replay it.
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
