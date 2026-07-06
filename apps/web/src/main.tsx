import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router";
import {App} from "./App";
import {initSentry} from "./lib/sentry";
import "./styles/global.css";

// Inert until a DSN is provisioned (ADR 0118) — no-ops with no `VITE_SENTRY_DSN`.
initSentry();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// FateProvider is no longer at the app root: its `session.isPending → null` remount
// guard (#438) would blank the entire static shell on every cold load (#2160). It now
// wraps only the fate-consuming subtree (the routed content + auth-dependent topbar
// chips) inside the shell frame in App.tsx, so the shell paints on the first frame.
createRoot(root).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>,
);
