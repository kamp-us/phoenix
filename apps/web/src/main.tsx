import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {RelayEnvironmentProvider} from "react-relay";
import {BrowserRouter} from "react-router";
import {App} from "./App";
import {environment} from "./relay/environment";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
	<StrictMode>
		<RelayEnvironmentProvider environment={environment}>
			<BrowserRouter>
				<App />
			</BrowserRouter>
		</RelayEnvironmentProvider>
	</StrictMode>,
);
