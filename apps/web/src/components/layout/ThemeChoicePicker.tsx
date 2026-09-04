import {ToggleGroup} from "@kampus/design";
import {type CatalogKey, useT} from "../../i18n";
import type {ThemeChoice} from "../../lib/theme";
import "./ThemeChoicePicker.css";

// The three-way theme control that replaces the topbar tema toggle (#2612). The
// `segmented` ToggleGroup track paints its active option with a neutral surface token,
// never an accent fill — so it stays inside the #2614 accent-scarcity containment law.
//
// A key per choice, not a label per choice — the copy comes out of the catalog (ADR 0347).
const THEME_LABEL_KEYS: Record<ThemeChoice, CatalogKey> = {
	light: "layout.theme.light",
	dark: "layout.theme.dark",
	auto: "layout.theme.auto",
};

const THEME_ORDER: readonly ThemeChoice[] = ["light", "dark", "auto"];

export function ThemeChoicePicker({
	choice,
	onChange,
	testId,
	className = "",
}: {
	choice: ThemeChoice;
	onChange: (choice: ThemeChoice) => void;
	testId?: string;
	className?: string;
}) {
	const t = useT();
	return (
		<div className={`kp-theme-picker ${className}`.trim()} data-testid={testId}>
			<ToggleGroup
				variant="primary"
				value={[choice]}
				// Radio semantics on a Toggle track: a click on the active option would
				// deselect it to an empty value, so drop the empty case — a theme picker
				// always resolves to exactly one choice, never "no theme".
				onValueChange={(v) => {
					const picked = THEME_ORDER.find((candidate) => candidate === v[0]);
					if (picked) onChange(picked);
				}}
				className="kp-toggle-group kp-toggle-group--segmented"
				items={THEME_ORDER.map((theme) => ({
					value: theme,
					label: t(THEME_LABEL_KEYS[theme]),
				}))}
			/>
		</div>
	);
}
