import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router";
import {App} from "./App";
import {FateProvider} from "./fate/FateProvider";
import {initSentry} from "./lib/sentry";
import "./styles/global.css";

// Inert until a DSN is provisioned (ADR 0118) — no-ops with no `VITE_SENTRY_DSN`.
initSentry();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
	<StrictMode>
		<FateProvider>
			<BrowserRouter>
				<App />
			</BrowserRouter>
		</FateProvider>
	</StrictMode>,
);
