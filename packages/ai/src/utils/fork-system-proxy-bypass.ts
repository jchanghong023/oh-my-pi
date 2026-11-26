import * as net from "node:net";

/**
 * Fork intranet bypass for the Windows system-proxy tier only, transcribed
 * from the corporate proxy-override list: company domains and CGNAT-style
 * ranges stay direct even when the per-user system proxy is enabled, because
 * the intranet is not reachable through the egress proxy. This list does NOT
 * gate `PI_PROXY` or env-var proxies — `NO_PROXY` stays their mechanism.
 *
 * Entry semantics, mirroring the source list's shape:
 * - leading `-` is the source format's exclusion marker and is stripped;
 * - an entry starting with a digit matches only IPv4 literals. Without a
 *   wildcard it is a prefix (`10.`, `100.120.`, `100.10`);
 * - an entry containing `*` is a glob over the whole hostname (`100.7*`,
 *   `wo-dr*.dbankcloud.ru`), subject to the IPv4 check above;
 * - an entry both starting and ending with `.` (`.hisilicon.`) matches any
 *   hostname containing that dotted label;
 * - a leading dot alone is a domain suffix (`.huawei.com`);
 * - anything else is an exact host or a dot-suffix of it.
 */
const FORK_SYSTEM_PROXY_BYPASS = [
	// Company domain suffixes and specific intranet hosts.
	"dev.huaweicloud.com",
	"dev.myhuaweicloud.com",
	".ai.smartcitysz.com",
	".athuawei.com",
	".hic.cloud",
	".hisilicon.",
	".hisilicon.cn",
	".huawei.cn",
	".huawei.com",
	".huaweimarine.com",
	".huaweimossel.",
	".huaweistatic.cn",
	".huaweistatic.com",
	".hw3static.cn",
	".hw3static.com",
	".hwht.",
	".hwtelcloud.com",
	".hwtrip.",
	".inhuawei.com",
	".pinjiantrip.com",
	".yinwang.com",
	".yw-beta.com",
	".yw-partners.com",
	"acm.chaspark.com",
	"cn-north-5-console.huaweicloud.com",
	"cn-north-5.myhuaweicloud.com",
	"cn-north-6.myhuaweicloud.com",
	"heds.huaweigsc.com",
	"irad.huaweigsc.com",
	"paper.chaspark.com",
	"papers.chaspark.com",
	"tool.chaspark.net",
	"csbjupyter.siye.console-his.huaweicloud.com",
	"his.chaspark.com",
	"models.ascend.huawei.com",
	"wo-dr.dbankcloud.cn",
	// IP-literal prefixes: Huawei CGNAT/RFC1918-style internal ranges.
	"7.",
	"10.",
	"100.10",
	"100.11",
	"100.120.",
	"100.121.",
	"100.122.",
	"100.123.",
	"100.124.",
	"100.125.",
	"100.126.",
	"100.64.",
	"100.65.",
	"100.66.",
	"100.67.",
	"100.68.",
	"100.69.",
	"127.0.0.1",
	"172.16.",
	"172.17.",
	"172.18.",
	"172.19.",
	"172.20.",
	"172.21.",
	"172.22.",
	"172.23.",
	"172.24.",
	"172.25.",
	"172.26.",
	"172.27.",
	"172.28.",
	"172.29.",
	"172.30.",
	"172.31.",
	"172.32.",
	// Globs from the source list.
	"100.7*",
	"100.8*",
	"100.9*",
	"127.0.0.1*",
	"wo-dr*.dbankcloud.ru",
] as const;

const forkSystemProxyBypassGlobs = FORK_SYSTEM_PROXY_BYPASS.filter(entry => entry.includes("*")).map(entry => ({
	ipv4Only: /^\d/.test(entry),
	pattern: new RegExp(
		`^${entry
			.split("*")
			.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join(".*")}$`,
	),
}));

/** Hostname match for {@link FORK_SYSTEM_PROXY_BYPASS}; see the entry semantics there. */
export function matchesForkSystemProxyBypass(hostname: string): boolean {
	const host = hostname
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	const ipv4 = net.isIPv4(hostname);
	if (forkSystemProxyBypassGlobs.some(({ ipv4Only, pattern }) => (!ipv4Only || ipv4) && pattern.test(host)))
		return true;
	for (const entry of FORK_SYSTEM_PROXY_BYPASS) {
		if (entry.includes("*")) continue;
		if (/^\d/.test(entry)) {
			if (ipv4 && host.startsWith(entry)) return true;
		} else if (entry.startsWith(".") && entry.endsWith(".")) {
			if (host.includes(entry)) return true;
		} else if (entry.startsWith(".")) {
			const clean = entry.slice(1);
			if (host === clean || host.endsWith(entry)) return true;
		} else if (host === entry || host.endsWith(`.${entry}`)) {
			return true;
		}
	}
	return false;
}
