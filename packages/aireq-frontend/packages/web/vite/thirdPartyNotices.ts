import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";
const noticesPath = fileURLToPath(new URL(`../../../${NOTICES_FILE}`, import.meta.url));

/** Serve and bundle the checked-in notices without regenerating license metadata. */
export function thirdPartyNoticesVitePlugin(): Plugin {
  return {
    name: "zcode:third-party-notices",
    buildStart() {
      this.addWatchFile(noticesPath);
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: NOTICES_FILE,
        source: await fs.readFile(noticesPath, "utf8"),
      });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (
          request.url?.split("?", 1)[0] !== `/${NOTICES_FILE}` ||
          (request.method !== "GET" && request.method !== "HEAD")
        ) {
          next();
          return;
        }
        fs.readFile(noticesPath)
          .then((source) => {
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/markdown; charset=utf-8");
            response.end(request.method === "HEAD" ? undefined : source);
          })
          .catch((error: unknown) => next(error));
      });
    },
    transformIndexHtml: {
      order: "post",
      handler: () => [{ tag: "link", attrs: { rel: "license", href: `/${NOTICES_FILE}` }, injectTo: "head" }],
    },
  };
}
