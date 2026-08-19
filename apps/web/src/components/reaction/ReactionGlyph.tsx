// Rendering only — ADR 0139 fixes the reaction SET and this does not re-open it; the emoji
// stays the canonical key on the wire, in storage, and in the ARIA gloss.
//
// No color or size literals belong here: the SVG paints in `currentColor` and scales to the
// button's glyph box, so ReactionBar.css tokens drive both.
import type {ReactNode} from "react";
import type {ReactionEmoji} from "../../../worker/db/reaction-emoji";

// `aria-hidden` because the accessible name is the parent button's ADR-0139 gloss; naming
// the glyph too would announce it twice.
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

function ThumbsUp() {
	return (
		<Glyph>
			<path d="M7 10v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Z" />
			<path d="M7 10l4-6a2 2 0 0 1 3 1.7V9h4.5a2 2 0 0 1 2 2.4l-1.3 6a2 2 0 0 1-2 1.6H7" />
		</Glyph>
	);
}

function Heart() {
	return (
		<Glyph>
			<path d="M12 20s-7-4.3-9-8.2C1.6 8.9 3 5.5 6.3 5.5c1.9 0 3.1 1 3.7 2 .6 1 1.4 1 2 0 .6-1 1.8-2 3.7-2 3.3 0 4.7 3.4 3.3 6.3C19 15.7 12 20 12 20Z" />
		</Glyph>
	);
}

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

export function ReactionGlyph({emoji}: {emoji: ReactionEmoji}) {
	const Icon = GLYPHS[emoji];
	return <Icon />;
}
