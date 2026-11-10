import "../packages/ui/src/dev/browserStorage.js";
import { createRoot } from "react-dom/client";
import { DevApplication } from "../app/DevApplication.js";
import { createOmpDataSource } from "./omp-data-source.js";
import "../packages/web/src/styles.css";

const root = createRoot(document.getElementById("root")!);
try {
  const source = await createOmpDataSource();
  root.render(<DevApplication source={source} />);
  window.addEventListener("pagehide", () => { void source.dispose(); }, { once: true });
} catch (cause) {
  root.render(<main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
    <section className="max-w-lg space-y-4">
      <h1 className="text-ui-lg font-medium">无法连接 OMP Dev</h1>
      <p role="alert" className="whitespace-pre-wrap break-words">{cause instanceof Error ? cause.message : String(cause)}</p>
      <button type="button" className="rounded-lg border border-border px-4 py-2" onClick={() => window.location.reload()}>重新连接</button>
    </section>
  </main>);
}
