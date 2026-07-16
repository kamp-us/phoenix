import {Surface} from "../../components/ui/Card";
import type {AnyExhibit} from "./exhibit";
import {PropKnobs} from "./PropKnobs";
import "./ExhibitStage.css";
import {type KnobState, useKnobs} from "./useKnobs";

const styles = {
	root: "kp-exhibit-stage",
	stage: "kp-exhibit-stage__stage",
	panel: "kp-exhibit-stage__panel",
	panelTitle: "kp-exhibit-stage__panel-title",
};

export interface ExhibitStageProps {
	readonly exhibit: AnyExhibit;
	/**
	 * Controlled knob state. Omit for a self-contained stage (its own in-memory knobs); the
	 * detail route passes a URL-backed state (`useUrlKnobs`) so knob twiddling deep-links (#3093).
	 */
	readonly knobs?: KnobState;
}

/**
 * The render harness: mounts an exhibit's component beside its prop-knobs and wires the two
 * so a knob change re-renders the component with the new prop. The knob-value → props seam is
 * a single spread — `{...fixedProps, ...values}` — over the current knob state.
 */
export function ExhibitStage({exhibit, knobs}: ExhibitStageProps) {
	// The uncontrolled fallback is always instantiated (hooks run unconditionally) but goes
	// unused when a controlled `knobs` state is supplied.
	const internal = useKnobs(exhibit.knobs);
	const {values, setKnob} = knobs ?? internal;
	const Component = exhibit.component;
	const props = {...exhibit.fixedProps, ...values};
	return (
		<div className={styles.root}>
			<Surface
				tone="sunken"
				radius="md"
				border
				padding="lg"
				className={styles.stage}
				data-testid="exhibit-stage"
			>
				<Component {...props} />
			</Surface>
			<Surface as="aside" tone="raised" radius="md" border padding="md" className={styles.panel}>
				<h3 className={styles.panelTitle}>Ayarlar</h3>
				<PropKnobs schema={exhibit.knobs} values={values} onChange={setKnob} />
			</Surface>
		</div>
	);
}
