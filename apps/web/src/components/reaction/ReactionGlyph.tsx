/**
 * The on-brand, OS-invariant glyphs for the curated reaction palette (#2165,
 * pillar cohesiveness; epic #2168). ADR 0139 fixes the reaction SET — the six
 * `REACTION_EMOJI` members and their Turkish glosses — and that membership is
 * SETTLED; this module does not re-open it. What it replaces is the *rendering*:
 * the bar used to paint each member as its raw OS emoji glyph, which (a) renders
 * differently on every OS and (b) drops a full-color glyph into the
 * monochrome-plus-accent palette. Instead every member is drawn as a controlled
 * inline SVG line-icon that strokes/fills in `currentColor`, so it inherits the
 * button's own token (text by default, accent when the viewer's reaction is
 * active) and looks identical everywhere.
 *
 * The icons are the same affective symbols ADR 0139 chose — 👍 beğendim,
 * ❤️ sevdim, 😂 güldüm, 🤔 düşündürdü, 😢 üzüldüm, 🔥 efsane — redrawn as
 * monochrome line-art, not a different reaction set. The palette emoji stays the
 * canonical identity/key everywhere else (wire, storage, ARIA gloss); this is a
 * presentation layer keyed BY that emoji.
 *
 * Kept a pure keyed lookup with no color/size literals of its own: the SVG uses
 * `currentColor` and scales to the button's glyph box, so color + size are driven
 * by ReactionBar.css tokens, never hardcoded here.
 */
import type {ReactNode} from "react";
import type {ReactionEmoji} from "../../../worker/db/reaction-emoji";

/**
 * Shared per-icon SVG frame: a 24×24 viewBox line-icon that fills the button's
 * glyph box and paints in `currentColor`. `aria-hidden` — the accessible name
 * lives on the parent button's `aria-label` (the ADR-0139 gloss), so the glyph
 * itself is decorative.
 */
function Glyph({children}: {children: ReactNode}) {
	return (
		<svg
			className="kp-reaction-bar__glyph"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{children}
		</svg>
	);
}

/** 👍 beğendim — thumbs-up. */
function ThumbsUp() {
	return (
		<Glyph>
			<path d="M7 10v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Z" />
			<path d="M7 10l4-6a2 2 0 0 1 3 1.7V9h4.5a2 2 0 0 1 2 2.4l-1.3 6a2 2 0 0 1-2 1.6H7" />
		</Glyph>
	);
}

/** ❤️ sevdim — heart. */
function Heart() {
	return (
		<Glyph>
			<path d="M12 20s-7-4.3-9-8.2C1.6 8.9 3 5.5 6.3 5.5c1.9 0 3.1 1 3.7 2 .6 1 1.4 1 2 0 .6-1 1.8-2 3.7-2 3.3 0 4.7 3.4 3.3 6.3C19 15.7 12 20 12 20Z" />
		</Glyph>
	);
}

/** 😂 güldüm — laughing face. */
function Laughing() {
	return (
		<Glyph>
			<circle cx="12" cy="12" r="9" />
			<path d="M8 10l2 1.5M16 10l-2 1.5" />
			<path d="M8 14a4 4 0 0 0 8 0Z" />
			<path d="M8.5 17.5c1 .6 2.2 1 3.5 1s2.5-.4 3.5-1" />
		</Glyph>
	);
}

/** 🤔 düşündürdü — thinking face. */
function Thinking() {
	return (
		<Glyph>
			<path d="M20.5 12A8.5 8.5 0 1 1 14 3.8" />
			<circle cx="9" cy="11" r="0.6" fill="currentColor" stroke="none" />
			<circle cx="15" cy="11" r="0.6" fill="currentColor" stroke="none" />
			<path d="M9.5 15.5c1.2-.7 3.8-.7 5 0" />
			<path d="M17.5 4.5c1.4 0 2.5 1 2.5 2.3S18.9 9 17.5 9" />
		</Glyph>
	);
}

/** 😢 üzüldüm — crying face. */
function Crying() {
	return (
		<Glyph>
			<circle cx="12" cy="12" r="9" />
			<circle cx="9" cy="10.5" r="0.6" fill="currentColor" stroke="none" />
			<circle cx="15" cy="10.5" r="0.6" fill="currentColor" stroke="none" />
			<path d="M9 17c.9-1 1.9-1.5 3-1.5s2.1.5 3 1.5" />
			<path d="M9 13v2.5" />
		</Glyph>
	);
}

/** 🔥 efsane — flame. */
function Flame() {
	return (
		<Glyph>
			<path d="M12 3c1 3 4 4.5 4 8.5A4 4 0 0 1 8 12c0-1.6.7-2.6 1.4-3.4C10 9.4 11 9 11 10c1-1 1-4 1-7Z" />
		</Glyph>
	);
}

const GLYPHS: Record<ReactionEmoji, () => ReactNode> = {
	"👍": ThumbsUp,
	"❤️": Heart,
	"😂": Laughing,
	"🤔": Thinking,
	"😢": Crying,
	"🔥": Flame,
};

/** Render the on-brand monochrome line-icon for a palette emoji (keyed by the ADR-0139 member). */
export function ReactionGlyph({emoji}: {emoji: ReactionEmoji}) {
	const Icon = GLYPHS[emoji];
	return <Icon />;
}
