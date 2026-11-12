import { createAIReqFrontendConfig } from "../vite.config.js";

export default function ompConfig() {
  return createAIReqFrontendConfig(import.meta.dirname, "build/omp", "./");
}
