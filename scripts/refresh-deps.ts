#!/usr/bin/env bun

import { $ } from "bun";
import { generateNixBunDeps, resolveNixBunDepsGenerator } from "./gen-nix-bun";

console.log("\n=== Full dependency refresh ===\n");
await $`rm -f bun.lock`;
await $`bun install`;
await $`cargo generate-lockfile`;
await generateNixBunDeps(resolveNixBunDepsGenerator());
await $`bun scripts/gen-clippy-bazelrc.ts`;
// Cargo.lock changed, so the crate_universe entry in MODULE.bazel.lock is
// stale; without a refresh every fresh CI bazel server re-splices (~4 min).
await $`bun scripts/gen-bazel-lock.ts`;
console.log("\nDependencies refreshed. Land these lockfile changes through a PR (or push to main).");
