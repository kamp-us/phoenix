/**
 * Karma — the reusable atom that surfaces a user's karma (ADR 0050,
 * `user_profile.total_karma`). One value-driven primitive every authorship-loop
 * surface shares: #1208 renders the signed-in user's own karma in the topbar
 * (`variant="inline"`) and on their own profile (`variant="stat"`), and the
 * downstream divan (#1290, "karma on others") and çaylak-status (#1291, the
 * "karma X / hedef Y" promotion bar) consume the SAME atom — `value` alone for a
 * bare karma, plus an optional `target` that switches it to the progress form.
 *
 * a11y: a visually-hidden span carries the accessible label ("karma: N" /
 * "karma: N / M") while the visual readout + bar are `aria-hidden`, so a screen
 * reader hears the label once, never a doubled "karma karma". State is carried by
 * the number + the "karma" text, never color alone; all colors are AA-contrast
 * role tokens; the bar's fill transition is neutralized by the global
 * prefers-reduced-motion reset (styles/global.css).
 */
import "./Karma.css";

export interface KarmaProps {
	/** The karma value to surface — `user_profile.total_karma`. 0 (a çaylak) and negatives are valid. */
	readonly value: number;
	/**
	 * Optional promotion target. When provided, the atom renders the
	 * "value / target" progress form (the çaylak→yazar bar, #1291) — a `<progress>`
	 * plus the "X / Y" readout — instead of the bare karma number.
	 */
	readonly target?: number;
	/** Visual density: "inline" packs into the topbar; "stat" matches a profile stat block. */
	readonly variant?: "inline" | "stat";
	/** The label noun; defaults to "karma" (a lowercase Turkish brand noun). */
	readonly label?: string;
	/** Test handle; defaults to "karma". Override so two on-page instances stay distinguishable. */
	readonly testId?: string;
	readonly className?: string;
}

/**
 * The accessible-name string, factored DOM-free so the labeling contract — bare
 * "karma: N" vs the "karma: N / M" progress form, and the honest zero-karma
 * readout — is unit-testable without jsdom (the pure-extraction idiom of
 * `flagGateChild` / `toProfileStatsState`; `apps/web/src` has no testing-library).
 */
export function karmaAriaLabel(value: number, target: number | undefined, label: string): string {
	return target === undefined ? `${label}: ${value}` : `${label}: ${value} / ${target}`;
}

export function Karma({
	value,
	target,
	variant = "inline",
	label = "karma",
	testId = "karma",
	className = "",
}: KarmaProps) {
	const isProgress = target !== undefined;
	const cls = ["kp-karma", `kp-karma--${variant}`, isProgress && "kp-karma--progress", className]
		.filter(Boolean)
		.join(" ");
	return (
		<span className={cls} data-testid={testId}>
			<span className="kp-karma__sr">{karmaAriaLabel(value, target, label)}</span>
			<span className="kp-karma__readout" aria-hidden="true">
				<span className="kp-karma__value">{value}</span>
				{isProgress ? <span className="kp-karma__target">/ {target}</span> : null}
				<span className="kp-karma__label">{label}</span>
			</span>
			{isProgress ? (
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
