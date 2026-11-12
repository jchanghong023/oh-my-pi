import { isMainThread } from "node:worker_threads";
import { createAIReqBackendServer } from "./server.js";
import { startScope } from "./scope.js";

if (!isMainThread && process.env.OMP_AIREQ_BACKEND_SCOPE === "1") {
	startScope();
} else if (isMainThread) {
	const rawPort = process.env.OMP_AIREQ_BACKEND_PORT ?? "4174";
	const port = Number(rawPort);
	if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("OMP_AIREQ_BACKEND_PORT must be an integer between 0 and 65535");
	const backend = createAIReqBackendServer({ hostname: process.env.OMP_AIREQ_BACKEND_HOST ?? "127.0.0.1", port });
	console.log(`AIReq prototype backend listening at ${backend.url.href}`);
	const shutdown = () => {
		void backend.dispose().then(() => process.exit(0));
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}
