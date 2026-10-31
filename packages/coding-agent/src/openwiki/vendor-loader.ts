import type { OpenWikiVendor } from "./vendor-contract";

// Resolve against the consumer's installed package, not the consumer bundle's
// output directory. Keeping this runtime import opaque prevents rebundling the
// generated vendor module and changing its initialization order.
const vendorSpecifier = ["@oh-my-pi/pi-coding-agent", "openwiki-vendor-runtime"].join("/");
const loadVendor = () => import(vendorSpecifier) as Promise<OpenWikiVendor>;

export async function loadOpenWikiVendor(): Promise<OpenWikiVendor> {
	return loadVendor();
}
