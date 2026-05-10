import {Component, type ErrorInfo, type ReactNode, Suspense} from "react";

/**
 * Pairing — a Suspense fallback for the loading state and an ErrorBoundary for
 * the failure state. Relay's `useLazyLoadQuery` suspends while fetching and
 * throws on network/server errors, so both rails are required to actually
 * render anything resembling a UI.
 *
 * No external dep — a tiny class component is enough; we don't need
 * react-error-boundary's reset/keys machinery yet. When we do, swap the
 * implementation and keep the API.
 */
type FallbackRender = (error: Error) => ReactNode;

interface ErrorBoundaryProps {
	fallback: FallbackRender;
	children: ReactNode;
}

interface ErrorBoundaryState {
	error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	override state: ErrorBoundaryState = {error: null};

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return {error};
	}

	override componentDidCatch(error: Error, info: ErrorInfo): void {
		// Surface to the console so dev tools / sentry integrations can pick it up
		// later without changing call sites.
		console.error("[QueryBoundary] caught error", error, info);
	}

	override render(): ReactNode {
		if (this.state.error) return this.props.fallback(this.state.error);
		return this.props.children;
	}
}

interface QueryBoundaryProps {
	loading: ReactNode;
	error: FallbackRender;
	children: ReactNode;
}

export function QueryBoundary({loading, error, children}: QueryBoundaryProps) {
	return (
		<ErrorBoundary fallback={error}>
			<Suspense fallback={loading}>{children}</Suspense>
		</ErrorBoundary>
	);
}
