/** The 9:16 frame every platform crops to, and the area their overlays leave readable. */
export const WIDTH = 1080;
export const HEIGHT = 1920;

/**
 * Inset from each edge that Reels, TikTok and Shorts keep free of their own UI: the top bar,
 * the action rail on the right, and the caption and audio strip along the bottom.
 */
export const SAFE = {top: 250, right: 150, bottom: 470, left: 72} as const;

export const SAFE_WIDTH = WIDTH - SAFE.left - SAFE.right;
export const SAFE_HEIGHT = HEIGHT - SAFE.top - SAFE.bottom;

export const glow = (strength: number): string =>
	`0 0 ${strength}px color-mix(in oklab, var(--accent) 70%, transparent), 0 0 ${strength * 3}px color-mix(in oklab, var(--accent) 35%, transparent)`;
