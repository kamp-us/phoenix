/**
 * The desk's error boundary. React unmounts the whole tree when a render throws and nothing catches
 * it, which on this surface means a blank tab and the reason only in a console the founder is not
 * reading (#7839, and #7560 before it). This is the only thing that can stop that: an error boundary
 * is a class component, because `getDerivedStateFromError` and `componentDidCatch` have no hook.
 *
 * Recovery is real rather than a button that re-throws. `resetKeys` clears a caught error whenever
 * the values behind the failed region change, so a snapshot that changes them recovers the desk on
 * its own; the button is for the case where nothing new arrives. The keys are compared with
 * `Object.is`, so a caller passes values and never objects it decoded — a fresh object per snapshot
 * would clear the panel on every frame, which is the failure this recovers from, not recovery.
 */

import {Component, type ErrorInfo, type ReactNode} from "react";

export interface ErrorBoundaryProps {
	readonly children: ReactNode;
	/** What the panel calls the region it replaced — "The desk layout", "Tuval". */
	readonly label: string;
	/** A change in any of these clears a caught error. Compared by identity, in order. */
	readonly resetKeys?: ReadonlyArray<unknown>;
	/**
	 * The failure panel's own box. It replaces a region, so it takes that region's class: the tiling
	 * area's `tuval-tiling` by default, and `tuval-surface` for a boundary above the desk, which is
	 * where the role tokens the panel paints in are declared.
	 */
	readonly className?: string;
}

interface ErrorBoundaryState {
	readonly error: Error | null;
	readonly componentStack: string | null;
}

const changed = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean =>
	a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));

/** The throw's own words. An `Error` with an empty message still has a name worth showing. */
const reasonOf = (error: Error): string => error.message || error.name || String(error);

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	override state: ErrorBoundaryState = {error: null, componentStack: null};

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		return {error};
	}

	override componentDidCatch(_error: Error, info: ErrorInfo): void {
		this.setState({componentStack: info.componentStack ?? null});
	}

	override componentDidUpdate(previous: ErrorBoundaryProps): void {
		if (this.state.error === null) return;
		if (!changed(previous.resetKeys ?? [], this.props.resetKeys ?? [])) return;
		this.reset();
	}

	private readonly reset = (): void => {
		this.setState({error: null, componentStack: null});
	};

	override render(): ReactNode {
		const {error, componentStack} = this.state;
		if (error === null) return this.props.children;
		return (
			<div
				className={`${this.props.className ?? "tuval-tiling"} tuval-boundary`}
				data-scheme="dark"
				role="alert"
			>
				<p className="tuval-boundary-title">{this.props.label} stopped rendering.</p>
				<p className="tuval-boundary-reason">{reasonOf(error)}</p>
				<button type="button" onClick={this.reset}>
					Render it again
				</button>
				{componentStack === null ? null : (
					<details className="tuval-boundary-where">
						<summary>Where it threw</summary>
						<pre className="tuval-boundary-stack">{componentStack.trim()}</pre>
					</details>
				)}
			</div>
		);
	}
}
