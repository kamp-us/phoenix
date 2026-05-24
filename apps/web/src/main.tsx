import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {RelayEnvironmentProvider} from "react-relay";
import {BrowserRouter} from "react-router";
import {App} from "./App";
import {FateProvider} from "./fate/FateProvider";
import {environment} from "./relay/environment";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// fate runs alongside Relay during the migration: the Relay environment still
// serves every screen except the ones already moved to fate. `FateProvider`
// (keyed on user id) adds the fate client to the tree; Relay teardown is task 10.
createRoot(root).render(
	<StrictMode>
		<RelayEnvironmentProvider environment={environment}>
			<FateProvider>
				<BrowserRouter>
					<App />
				</BrowserRouter>
			</FateProvider>
		</RelayEnvironmentProvider>
	</StrictMode>,
);
