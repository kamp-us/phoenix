import {ToggleGroup} from "@kampus/design";
import type {Density} from "../../lib/density";
import "./Controls.css";

export type {Density};

export type ColorTheme =
	| "ember"
	| "crimson"
	| "amber"
	| "jade"
	| "teal"
	| "cyan"
	| "indigo"
	| "iris"
	| "plum"
	| "mauve";

export type Mode = "dark" | "light";

const THEME_SWATCHES: Record<ColorTheme, string> = {
	ember: "#e54d2e",
	crimson: "#e93d82",
	amber: "#ffc53d",
	jade: "#29a383",
	teal: "#12a594",
	cyan: "#00a2c7",
	indigo: "#3e63dd",
	iris: "#5b5bd6",
	plum: "#ab4aba",
	mauve: "#7c7a85",
};

const DENSITY_LABELS: Record<Density, string> = {
	compact: "sıkı",
	normal: "normal",
	spacious: "ferah",
};

const MODE_LABELS: Record<Mode, string> = {
	dark: "koyu",
	light: "açık",
};

export function ThemePicker({
	value,
	onChange,
}: {
	value: ColorTheme;
	onChange: (v: ColorTheme) => void;
}) {
	return (
		<div className="kp-controls__group">
			<span className="kp-controls__label">renk</span>
			<ToggleGroup
				variant="primary"
				value={[value]}
				onValueChange={(v) => v[0] && onChange(v[0] as ColorTheme)}
				className="kp-toggle-group kp-toggle-group--swatch"
				items={(Object.keys(THEME_SWATCHES) as ColorTheme[]).map((theme) => ({
					value: theme,
					label: (
						<span className="kp-toggle__swatch" style={{backgroundColor: THEME_SWATCHES[theme]}}>
							<span className="kp-visually-hidden">{theme}</span>
						</span>
					),
				}))}
			/>
		</div>
	);
}

export function DensityToggle({value, onChange}: {value: Density; onChange: (v: Density) => void}) {
	return (
		<div className="kp-controls__group">
			<span className="kp-controls__label">yoğunluk</span>
			<ToggleGroup
				variant="primary"
				value={[value]}
				onValueChange={(v) => v[0] && onChange(v[0] as Density)}
				className="kp-toggle-group kp-toggle-group--segmented"
				items={(Object.keys(DENSITY_LABELS) as Density[]).map((density) => ({
					value: density,
					label: DENSITY_LABELS[density],
				}))}
			/>
		</div>
	);
}

export function ModeToggle({value, onChange}: {value: Mode; onChange: (v: Mode) => void}) {
	return (
		<div className="kp-controls__group">
			<span className="kp-controls__label">mod</span>
			<ToggleGroup
				variant="primary"
				value={[value]}
				onValueChange={(v) => v[0] && onChange(v[0] as Mode)}
				className="kp-toggle-group kp-toggle-group--segmented"
				items={(Object.keys(MODE_LABELS) as Mode[]).map((mode) => ({
					value: mode,
					label: MODE_LABELS[mode],
				}))}
			/>
		</div>
	);
}

export function Controls(props: {
	theme: ColorTheme;
	onThemeChange: (v: ColorTheme) => void;
	mode: Mode;
	onModeChange: (v: Mode) => void;
	density: Density;
	onDensityChange: (v: Density) => void;
}) {
	return (
		<div className="kp-controls">
			<ThemePicker value={props.theme} onChange={props.onThemeChange} />
			<ModeToggle value={props.mode} onChange={props.onModeChange} />
			<DensityToggle value={props.density} onChange={props.onDensityChange} />
		</div>
	);
}
