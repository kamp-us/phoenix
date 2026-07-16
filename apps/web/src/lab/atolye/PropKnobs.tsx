import {useId} from "react";
import {Field, Input, Label} from "../../components/ui/Form";
import {Switch} from "../../components/ui/Switch";
import {ToggleGroup} from "../../components/ui/ToggleGroup";
import type {AnyKnob, AnyKnobSchema, KnobValue, KnobValues} from "./knob";
import "./PropKnobs.css";

const styles = {
	root: "kp-knobs",
	empty: "kp-knobs__empty",
	row: "kp-knobs__row",
	label: "kp-knobs__label",
};

export interface PropKnobsProps {
	readonly schema: AnyKnobSchema;
	readonly values: KnobValues;
	readonly onChange: (key: string, value: KnobValue) => void;
}

/** The prop-knobs panel — one labelled control per knob, controlled by the caller's values. */
export function PropKnobs({schema, values, onChange}: PropKnobsProps) {
	const entries = Object.entries(schema);
	if (entries.length === 0) {
		return (
			<p className={styles.empty} aria-live="polite">
				Bu sergide ayarlanabilir bir özellik yok.
			</p>
		);
	}
	return (
		<div className={styles.root}>
			{entries.map(([key, knob]) => (
				<KnobRow
					key={key}
					name={key}
					knob={knob}
					value={values[key] ?? knob.default}
					onChange={(value) => onChange(key, value)}
				/>
			))}
		</div>
	);
}

function KnobRow({
	name,
	knob,
	value,
	onChange,
}: {
	name: string;
	knob: AnyKnob;
	value: KnobValue;
	onChange: (value: KnobValue) => void;
}) {
	const labelId = useId();
	const text = knob.label ?? name;
	return (
		<Field className={styles.row}>
			<Label id={labelId} className={styles.label}>
				{text}
			</Label>
			<KnobControl name={name} knob={knob} value={value} labelId={labelId} onChange={onChange} />
		</Field>
	);
}

function KnobControl({
	name,
	knob,
	value,
	labelId,
	onChange,
}: {
	name: string;
	knob: AnyKnob;
	value: KnobValue;
	labelId: string;
	onChange: (value: KnobValue) => void;
}) {
	switch (knob.kind) {
		case "string":
			return (
				<Input
					aria-labelledby={labelId}
					data-knob={name}
					placeholder={knob.placeholder}
					value={String(value)}
					onChange={(event) => onChange(event.target.value)}
				/>
			);
		case "number":
			return (
				<Input
					type="number"
					aria-labelledby={labelId}
					data-knob={name}
					min={knob.min}
					max={knob.max}
					step={knob.step}
					value={String(value)}
					onChange={(event) => onChange(event.target.valueAsNumber)}
				/>
			);
		case "boolean":
			return (
				<Switch
					aria-labelledby={labelId}
					data-knob={name}
					checked={Boolean(value)}
					onCheckedChange={(checked) => onChange(checked)}
				/>
			);
		case "enum":
			return (
				<EnumControl name={name} knob={knob} value={value} labelId={labelId} onChange={onChange} />
			);
	}
}

function EnumControl({
	name,
	knob,
	value,
	labelId,
	onChange,
}: {
	name: string;
	knob: Extract<AnyKnob, {kind: "enum"}>;
	value: KnobValue;
	labelId: string;
	onChange: (value: KnobValue) => void;
}) {
	// base-ui ToggleGroup keys on `string` values, so options are stringified at the control
	// boundary and mapped back to their real (possibly non-string) knob value on change.
	const asKey = (v: KnobValue) => String(v);
	return (
		<ToggleGroup.Root
			variant="segmented"
			aria-labelledby={labelId}
			data-knob={name}
			value={[asKey(value)]}
			onValueChange={(next) => {
				// Single-select semantics over a multi-select group: the last-pressed key wins;
				// deselecting the active item (empty array) keeps the current value.
				const key = next.length > 0 ? next[next.length - 1] : asKey(value);
				const option = knob.options.find((o) => asKey(o.value) === key);
				if (option) onChange(option.value);
			}}
		>
			{knob.options.map((option) => (
				<ToggleGroup.Item key={asKey(option.value)} value={asKey(option.value)}>
					{option.label ?? String(option.value)}
				</ToggleGroup.Item>
			))}
		</ToggleGroup.Root>
	);
}
