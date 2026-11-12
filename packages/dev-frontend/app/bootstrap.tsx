import "../packages/ui/src/dev/browserStorage.js";
import { createRoot } from "react-dom/client";
import { DevApplication } from "./DevApplication.js";
import { createRemoteDevDataSource } from "../client/remote-data-source.js";
import "../packages/web/src/styles.css";

const root = createRoot(document.getElementById("root")!);
async function start() {
	const query = new URLSearchParams(location.search);
	const source = await createRemoteDevDataSource({
		baseUrl: query.get("backend") ?? import.meta.env.VITE_DEV_BACKEND_URL ?? "http://127.0.0.1:4174/",
		demo: query.get("demo") ?? undefined,
	});
	root.render(<DevApplication source={source} />);
	window.addEventListener(
		"pagehide",
		() => {
			void source.dispose();
		},
		{ once: true },
	);
}
void start().catch((cause: unknown) => {
	root.render(
		<main role="alert" className="p-8">
			<h1>Dev 后端连接失败</h1>
			<p>{cause instanceof Error ? cause.message : String(cause)}</p>
			<button onClick={() => location.reload()}>重试连接</button>
		</main>,
	);
});
