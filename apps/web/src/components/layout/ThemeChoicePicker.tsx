import type {ThemeChoice} from "../../lib/theme";
import {ToggleGroup} from "../ui/ToggleGroup";

// The three-way theme control that replaces the topbar tema toggle (#2612). The
// `segmented` ToggleGroup track paints its active option with a neutral surface token,
// never an accent fill — so it stays inside the #2614 accent-scarcity containment law.
const THEME_LABELS: Record<ThemeChoice, string> = {
	light: "açık",
	dark: "koyu",
	auto: "otomatik",
};

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
	return (
		<div className={`kp-theme-picker ${className}`.trim()} data-testid={testId}>
			<ToggleGroup.Root
				variant="segmented"
				value={[choice]}
				// Radio semantics on a Toggle track: a click on the active option would
				// deselect it to an empty value, so drop the empty case — a theme picker
				// always resolves to exactly one choice, never "no theme".
				onValueChange={(v) => v[0] && onChange(v[0] as ThemeChoice)}
				aria-label="Tema"
			>
				{(Object.keys(THEME_LABELS) as ThemeChoice[]).map((c) => (
					<ToggleGroup.Item key={c} value={c}>
						{THEME_LABELS[c]}
					</ToggleGroup.Item>
				))}
			</ToggleGroup.Root>
		</div>
	);
}
