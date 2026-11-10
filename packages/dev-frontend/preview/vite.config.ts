import { createDevFrontendConfig } from "../vite.config.js";

export default function previewConfig() {
  return createDevFrontendConfig(import.meta.dirname, "build/dev");
}
