import "../packages/ui/src/dev/browserStorage.js";
import { createRoot } from "react-dom/client";
import { DevApplication } from "../app/DevApplication.js";
import { createPrototypeDataSource } from "./prototype-data-source.js";

const source = createPrototypeDataSource();
createRoot(document.getElementById("root")!).render(<DevApplication source={source} />);
window.addEventListener("pagehide", () => { void source.dispose(); }, { once: true });
