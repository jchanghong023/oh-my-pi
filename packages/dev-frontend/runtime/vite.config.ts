import { createDevFrontendConfig } from "../vite.config.js";

export default function ompConfig() {
  return createDevFrontendConfig(import.meta.dirname, "build/omp");
}
