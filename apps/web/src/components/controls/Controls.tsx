import type {Density} from "../../lib/density";
import {ToggleGroup} from "../ui/ToggleGroup";
import "./Controls.css";

export type {Density};

export type Mode = "dark" | "light";

const DENSITY_LABELS: Record<Density, string> = {
	compact: "sıkı",
	normal: "normal",
	spacious: "ferah",
};

const MODE_LABELS: Record<Mode, string> = {
	dark: "koyu",
	light: "açık",
};

export function DensityToggle({value, onChange}: {value: Density; onChange: (v: Density) => void}) {
	return (
		<div className="kp-controls__group">
			<span className="kp-controls__label">yoğunluk</span>
			<ToggleGroup.Root
				variant="segmented"
				value={[value]}
				onValueChange={(v) => v[0] && onChange(v[0] as Density)}
				aria-label="Yoğunluk"
			>
				{(Object.keys(DENSITY_LABELS) as Density[]).map((d) => (
					<ToggleGroup.Item key={d} value={d}>
						{DENSITY_LABELS[d]}
					</ToggleGroup.Item>
				))}
			</ToggleGroup.Root>
		</div>
	);
}

export function ModeToggle({value, onChange}: {value: Mode; onChange: (v: Mode) => void}) {
	return (
		<div className="kp-controls__group">
			<span className="kp-controls__label">mod</span>
			<ToggleGroup.Root
				variant="segmented"
				value={[value]}
				onValueChange={(v) => v[0] && onChange(v[0] as Mode)}
				aria-label="Renk modu"
			>
				{(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
					<ToggleGroup.Item key={m} value={m}>
						{MODE_LABELS[m]}
					</ToggleGroup.Item>
				))}
			</ToggleGroup.Root>
		</div>
	);
}

export function Controls(props: {
	mode: Mode;
	onModeChange: (v: Mode) => void;
	density: Density;
	onDensityChange: (v: Density) => void;
}) {
	return (
		<div className="kp-controls">
			<ModeToggle value={props.mode} onChange={props.onModeChange} />
			<DensityToggle value={props.density} onChange={props.onDensityChange} />
		</div>
	);
}
