import {Triangle} from "lucide-react";
import "./vote-cue.css";

// See ADR 0166 §6. The outline/filled toggle lives in vote-cue.css, keyed off the
// ancestor button's aria-pressed — shape is the non-color cue (WCAG 1.4.1).
export function VoteTriangle({dir = "up"}: {dir?: "up" | "down"}) {
	return <Triangle className={`triangle triangle--${dir}`} size={16} aria-hidden="true" />;
}
