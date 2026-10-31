// OMP's own CLI bundles the same fork entry used by the source checkout.
const loadVendor = () => import("#openwiki-vendor");

export function loadOpenWikiVendor() {
	return loadVendor();
}
