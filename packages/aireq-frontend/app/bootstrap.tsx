import "../packages/ui/src/aireq/browserStorage.js";
import { createRoot } from "react-dom/client";
import { AIReqApplication } from "./AIReqApplication.js";
import { createRemoteAIReqDataSource } from "../client/remote-data-source.js";
import "../packages/web/src/styles.css";

const root = createRoot(document.getElementById("root")!);
async function start() {
	const query = new URLSearchParams(location.search);
	const source = await createRemoteAIReqDataSource({
		baseUrl: query.get("backend") ?? import.meta.env.VITE_AIREQ_BACKEND_URL ?? new URL(import.meta.env.BASE_URL, document.baseURI).href,
		demo: query.get("demo") ?? undefined,
	});
	root.render(<AIReqApplication source={source} />);
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
			<h1>AIReq 后端连接失败</h1>
			<p>{cause instanceof Error ? cause.message : String(cause)}</p>
			<button onClick={() => location.reload()}>重试连接</button>
		</main>,
	);
});
