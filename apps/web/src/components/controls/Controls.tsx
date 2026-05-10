import * as React from 'react';
import { ToggleGroup } from '../ui/ToggleGroup';
import './Controls.css';

export type ColorTheme =
  | 'ember' | 'crimson' | 'amber' | 'jade' | 'teal'
  | 'cyan'  | 'indigo'  | 'iris'  | 'plum' | 'mauve';

export type Mode = 'dark' | 'light';
export type Density = 'compact' | 'normal' | 'spacious';

const THEME_SWATCHES: Record<ColorTheme, string> = {
  ember:   '#e54d2e',
  crimson: '#e93d82',
  amber:   '#ffc53d',
  jade:    '#29a383',
  teal:    '#12a594',
  cyan:    '#00a2c7',
  indigo:  '#3e63dd',
  iris:    '#5b5bd6',
  plum:    '#ab4aba',
  mauve:   '#7c7a85',
};

const DENSITY_LABELS: Record<Density, string> = {
  compact:  'sıkı',
  normal:   'normal',
  spacious: 'ferah',
};

const MODE_LABELS: Record<Mode, string> = {
  dark:  'koyu',
  light: 'açık',
};

export function ThemePicker({
  value, onChange,
}: { value: ColorTheme; onChange: (v: ColorTheme) => void }) {
  return (
    <div className="kp-controls__group">
      <span className="kp-controls__label">renk</span>
      <ToggleGroup.Root
        variant="swatch"
        value={[value]}
        onValueChange={(v) => v[0] && onChange(v[0] as ColorTheme)}
        aria-label="Renk teması"
      >
        {(Object.keys(THEME_SWATCHES) as ColorTheme[]).map((t) => (
          <ToggleGroup.Item
            key={t}
            value={t}
            aria-label={t}
            swatchColor={THEME_SWATCHES[t]}
          />
        ))}
      </ToggleGroup.Root>
    </div>
  );
}

export function DensityToggle({
  value, onChange,
}: { value: Density; onChange: (v: Density) => void }) {
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

export function ModeToggle({
  value, onChange,
}: { value: Mode; onChange: (v: Mode) => void }) {
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
  theme: ColorTheme; onThemeChange: (v: ColorTheme) => void;
  mode: Mode; onModeChange: (v: Mode) => void;
  density: Density; onDensityChange: (v: Density) => void;
}) {
  return (
    <div className="kp-controls">
      <ThemePicker   value={props.theme}   onChange={props.onThemeChange} />
      <ModeToggle    value={props.mode}    onChange={props.onModeChange} />
      <DensityToggle value={props.density} onChange={props.onDensityChange} />
    </div>
  );
}
