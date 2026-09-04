/**
 * Karma — the reusable atom that surfaces a user's karma (ADR 0050,
 * `user_profile.total_karma`). The visual readout and bar are `aria-hidden`
 * behind one visually-hidden label, so a screen reader hears "karma" once
 * instead of twice.
 */
import {useT} from "../../i18n";
import "./Karma.css";

export interface KarmaProps {
	/** 0 (a çaylak) and negatives are valid karma values. */
	readonly value: number;
	/** Present ⇒ the "value / target" progress form (the çaylak→yazar bar, #1291). */
	readonly target?: number;
	/**
	 * With a `target`, whether the bar itself is drawn. Off ⇒ the delta readout alone — the
	 * unvouched çaylak's honest state, where the target is real but no bar may depict a goal
	 * that maps to no live promotion trigger (#1323, #7045). Inert without a `target`.
	 */
	readonly showBar?: boolean;
	readonly variant?: "inline" | "stat";
	/** Defaults to the catalog's `karma.label`. */
	readonly label?: string;
	readonly testId?: string;
	readonly className?: string;
}

/** Factored out of the component so the labeling contract is testable without a DOM. */
export function karmaAriaLabel(value: number, target: number | undefined, label: string): string {
	return target === undefined ? `${label}: ${value}` : `${label}: ${value} / ${target}`;
}

export function Karma({
	value,
	target,
	showBar = true,
	variant = "inline",
	label,
	testId = "karma",
	className = "",
}: KarmaProps) {
	const t = useT();
	const resolvedLabel = label ?? t("karma.label");
	const isProgress = target !== undefined;
	const cls = ["kp-karma", `kp-karma--${variant}`, isProgress && "kp-karma--progress", className]
		.filter(Boolean)
		.join(" ");
	return (
		<span className={cls} data-testid={testId}>
			<span className="kp-karma__sr">{karmaAriaLabel(value, target, resolvedLabel)}</span>
			<span className="kp-karma__readout" aria-hidden="true">
				<span className="kp-karma__value">{value}</span>
				{isProgress ? <span className="kp-karma__target">/ {target}</span> : null}
				<span className="kp-karma__label">{resolvedLabel}</span>
			</span>
			{isProgress && showBar ? (
				<progress
					className="kp-karma__bar"
					max={target}
					value={Math.max(0, value)}
					aria-hidden="true"
				/>
			) : null}
		</span>
	);
}
