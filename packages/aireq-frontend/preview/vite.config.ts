import { createAIReqFrontendConfig } from "../vite.config.js";

export default function previewConfig() {
  return createAIReqFrontendConfig(import.meta.dirname, "build/aireq");
}
