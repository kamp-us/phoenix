import {Triangle} from "lucide-react";
import "./vote-cue.css";

// See ADR 0166 §6 — the vote affordance is a DRAWN triangle (the HN / lobste.rs
// lineage), not a Unicode △. Shape carries the redundant non-color cue (WCAG 1.4.1):
// outline when not voted, filled when the ancestor button is aria-pressed — the toggle
// lives in vote-cue.css so every vote site shares one cue. Stroke is currentColor, so
// the glyph takes each button's own role-token color (accent on cast). `dir` supplies
// the up/down symmetry §6 requires.
export function VoteTriangle({dir = "up"}: {dir?: "up" | "down"}) {
	return <Triangle className={`triangle triangle--${dir}`} size={16} aria-hidden="true" />;
}
