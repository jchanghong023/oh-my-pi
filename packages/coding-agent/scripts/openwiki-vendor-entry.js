// The npm package omits the TypeScript checkout entry and ships this bridge.
// Source checkouts resolve the sibling .ts first; consumers bundle the fork artifact.
export * from "../dist/openwiki-vendor.js";
