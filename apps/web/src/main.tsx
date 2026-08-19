import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router";
import "@manti-ui/styles/index.css";
import {App} from "./App";
import {initSentry} from "./lib/sentry";
import "./styles/global.css";

// Inert until a DSN is provisioned (ADR 0118) — no-ops with no `VITE_SENTRY_DSN`.
initSentry();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// Deliberately no FateProvider here: its `session.isPending → null` guard (#438) would blank
// the whole shell on every cold load, so it wraps only the fate-consuming subtree in App.tsx (#2160).
createRoot(root).render(
	<StrictMode>
		<BrowserRouter>
			<App />
		</BrowserRouter>
	</StrictMode>,
);
