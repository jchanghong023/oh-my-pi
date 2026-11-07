import { createRoot } from "react-dom/client";
import { Workbench } from "./Workbench";
import "../styles/tokens.css";
import "../styles/base.css";
import "../components/shell/shell.css";
import "../components/agents/agents.css";
// Keep the universal compatibility baseline last, after shared component CSS.
import "./legacy.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
// This document is the separate Dev entry; do not write Collab's saved preference.
document.documentElement.dataset.theme = "dark";
document.documentElement.classList.add("dw-document");
document.documentElement.style.colorScheme = "dark";
createRoot(root).render(<Workbench />);
