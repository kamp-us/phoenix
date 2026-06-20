/**
 * The fate screen rails — `Suspense` + an error boundary, paired, so a screen
 * only declares its fallback + error UI. fate reads suspend and throw a
 * `FateRequestError` on boundary-class failures.
 *
 * This boundary catches **thrown** errors only; mutation errors a call site
 * handles inline never reach here (that split lives in the mutation hooks — see
 * `.patterns/fate-mutations-client.md`). It surfaces the error's `code` so
 * screens can branch on it (e.g. `UNAUTHORIZED` vs `NOT_FOUND`).
 *
 * See `.patterns/fate-client-setup.md`.
 */
import {Component, type ErrorInfo, type ReactNode, Suspense} from "react";
import type {FateWireCode} from "../lib/fateWireCodes";

/**
 * The fate wire `code` a screen branches on. The known {@link FateWireCode}
 * literals keep autocompletion, but this stays open (`string`) on purpose: a
 * boundary throw can carry a code the narrowed `decodeFateWireCode` set omits
 * (e.g. a bare `NOT_FOUND`), so this is the *un-narrowed* read of the same
 * vocabulary, not a second one.
 */
export type ScreenErrorCode = FateWireCode | (string & {});

type FallbackRender = (error: {code: ScreenErrorCode; error: Error}) => ReactNode;

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
	}

	override render(): ReactNode {
		const {error} = this.state;
		if (error) {
			// Forward the wire `code` verbatim — the screen vocabulary is wider
			// than fate's closed union (e.g. `NOT_FOUND`), so this does NOT narrow
			// through `decodeFateWireCode` the way `wire.codeOf` does.
			const code: ScreenErrorCode = isFateError(error) ? error.code : "INTERNAL_SERVER_ERROR";
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
