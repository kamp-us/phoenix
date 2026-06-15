import {EpicDetail} from "./pages/EpicDetail.tsx";
import {QueueBoard} from "./pages/QueueBoard.tsx";

export function App() {
	return (
		<main>
			<h1>phoenix dashboard</h1>
			<QueueBoard />
			<EpicDetail />
		</main>
	);
}
