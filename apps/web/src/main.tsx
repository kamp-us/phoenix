import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import {BrowserRouter} from "react-router";
import {App} from "./App";
import {FateProvider} from "./fate/FateProvider";
import "./styles/global.css";

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
