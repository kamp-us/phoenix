import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router";
import {App} from "./App";
import {FateProvider} from "./fate/FateProvider";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// fate is the single data layer. `FateProvider` (keyed on user id) adds the
// fate client to the tree.
createRoot(root).render(
	<StrictMode>
		<FateProvider>
			<BrowserRouter>
				<App />
			</BrowserRouter>
		</FateProvider>
	</StrictMode>,
);
