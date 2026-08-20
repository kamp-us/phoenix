/**
 * The fate screen rails — `Suspense` + an error boundary, paired. Catches **thrown**
 * errors only; mutation errors a call site handles inline never reach here. See
 * `.patterns/fate-client-setup.md` and `.patterns/fate-mutations-client.md`.
 */
import {Component, type ErrorInfo, type ReactNode, Suspense} from "react";
import type {FateWireCode} from "../lib/fateWireCodes";
import {captureBoundaryError} from "../lib/sentry";

/**
 * The open `string & {}` arm stays on purpose: a fate-internal throw bypasses the
 * annotation codec and carries fate's own `INTERNAL_ERROR`, a code `FATE_WIRE_CODES`
 * omits, so this read must not be closed to that set.
 */
type FallbackRender = (error: {code: FateWireCode | (string & {}); error: Error}) => ReactNode;

// `FateRequestError` is only exported from `@nkzw/fate/server`, not the client
// entrypoints, so we duck-type on the string `code` field rather than `instanceof`.
const isFateError = (error: unknown): error is {code: string} =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	typeof (error as {code: unknown}).code === "string";

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
		console.error("[fate Screen] caught error", error, info);
		// ADR 0118; inert until a DSN is set.
		captureBoundaryError(error, info.componentStack);
	}

	override render(): ReactNode {
		const {error} = this.state;
		if (error) {
			// Deliberately does NOT narrow through `decodeFateWireCode` the way
			// `wire.codeOf` does — the code is forwarded verbatim.
			const code = isFateError(error) ? error.code : "INTERNAL_SERVER_ERROR";
			return this.props.fallback({code, error});
		}
		return this.props.children;
	}
}

interface ScreenProps {
	children: ReactNode;
	fallback: ReactNode;
	error: FallbackRender;
}

export function Screen({children, fallback, error}: ScreenProps) {
	return (
		<ErrorBoundary fallback={error}>
			<Suspense fallback={fallback}>{children}</Suspense>
		</ErrorBoundary>
	);
}
