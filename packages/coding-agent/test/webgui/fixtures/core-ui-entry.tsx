import { AppErrorBoundary } from "@/ErrorBoundary.js";
import { createRoot } from "react-dom/client";
import "../../../../../vendor/zcode-frontend/packages/web/src/styles.css";
import { SubagentCase } from "./subagent-case";

const kind = new URLSearchParams(window.location.search).get("case");
if (kind !== "subagent") throw new Error(`Unknown core UI case: ${kind}`);
const root = document.getElementById("root");
if (!root) throw new Error("Core UI fixture root is missing");

createRoot(root).render(
	<AppErrorBoundary>
		<SubagentCase />
	</AppErrorBoundary>,
);
