/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { combine, register } from "../config/registry";
import { BUILTIN_BLOB_DESTINATIONS, type BlobDestinationId, type BlobDestinationMetadata } from "./destinations";

const DEFAULT_IMAGES_URLS_BACKENDS: BlobDestinationId[] = ["provider-files", "tailscale", "cloudflared", "litterbox"];
const EMPTY_IMAGES_URLS_OPTIONS: Partial<Record<BlobDestinationId, Record<string, unknown>>> = {};
const EMPTY_IMAGES_URLS_CREDENTIALS: Partial<Record<BlobDestinationId, Record<string, string>>> = {};

const BUILTIN_BLOB_DESTINATION_METADATA: readonly BlobDestinationMetadata<BlobDestinationId>[] =
	Object.values(BUILTIN_BLOB_DESTINATIONS);

const BLOB_BACKEND_CHOICES = BUILTIN_BLOB_DESTINATION_METADATA.filter(
	destination =>
		destination.id === "provider-files" ||
		(destination.directImage && destination.status !== "incompatible" && destination.status !== "defunct"),
).map(destination => ({
	value: destination.id,
	label: destination.label,
	description: destination.reason ?? destination.family,
}));

export const cfgImagesUrlsEnabled = register({
	id: "images.urls.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "model",
		group: "视觉",
		label: "通过 URL 提供图片",
		description:
			"通过配置的后端链发布待发送图片，为支持抓取 URL 的 Provider 发送短 URL，而非内联 base64。所有后端或 Provider 抓取失败时自动回退到内联方式",
	},
});

export const cfgImagesUrlsBackends = register({
	id: "images.urls.backends",
	type: "array",
	default: DEFAULT_IMAGES_URLS_BACKENDS,
	ui: {
		tab: "model",
		group: "视觉",
		label: "图片 URL 后端",
		description: "发布图片供 Provider 访问时，按顺序尝试的目标",
		options: BLOB_BACKEND_CHOICES,
		ordered: true,
	},
});

export const cfgImagesUrlsOptions = register({
	id: "images.urls.options",
	type: "record",
	default: EMPTY_IMAGES_URLS_OPTIONS,
});

export const cfgImagesUrlsCredentials = register({
	id: "images.urls.credentials",
	type: "record",
	default: EMPTY_IMAGES_URLS_CREDENTIALS,
	credential: true,
});

export const cfgImagesUrlsCommand = register({
	id: "images.urls.command",
	type: "string",
	default: undefined,
	ui: {
		tab: "model",
		group: "视觉",
		label: "图片上传命令",
		description:
			"command 后端的参数模板；{file} 为图片路径，{mime}/{ext} 可选。使用 stdout 输出的最后一个 URL（例如 pasta -b -f {file}）",
	},
});

export const cfgImagesUrlsPublicBaseUrl = register({
	id: "images.urls.publicBaseUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "model",
		group: "视觉",
		label: "图片 URL 公共基础地址",
		description: "对外可访问的 blob 服务器基础 URL（ssh 必填，direct 可选）",
	},
});

export const cfgImagesUrlsTtlHours = register({
	id: "images.urls.ttlHours",
	type: "number",
	default: 72,
	ui: {
		tab: "model",
		group: "视觉",
		label: "图片 URL 有效期（小时）",
		description:
			"本地托管图片 URL 的服务期限，从对话最后一次发送图片时起算；恢复对话时在原链接上重新计时。0 表示代理服务运行期间链接持续有效",
	},
});

export const cfgImagesUrlsBindHost = register({
	id: "images.urls.bindHost",
	type: "string",
	default: "127.0.0.1",
	ui: {
		tab: "model",
		group: "视觉",
		label: "图片 URL 绑定主机",
		description: "blob 服务器绑定的主机；隧道使用回环地址，直接提供服务使用 0.0.0.0",
	},
});

export const cfgImagesUrlsSshTarget = register({
	id: "images.urls.sshTarget",
	type: "string",
	default: undefined,
	ui: {
		tab: "model",
		group: "视觉",
		label: "图片 URL SSH 目标",
		description: "ssh 反向转发的 user@host 目标",
	},
});

export const cfgImagesUrlsSshRemotePort = register({
	id: "images.urls.sshRemotePort",
	type: "number",
	default: 8787,
	ui: {
		tab: "model",
		group: "视觉",
		label: "图片 URL SSH 远程端口",
		description: "ssh 反向转发的远程监听端口，网页服务器将请求代理至此",
	},
});

/** Every `images.urls.*` setting; the live image URL service rebuilds when any changes. */
export const cfgImagesUrls = combine({
	enabled: cfgImagesUrlsEnabled,
	backends: cfgImagesUrlsBackends,
	options: cfgImagesUrlsOptions,
	credentials: cfgImagesUrlsCredentials,
	command: cfgImagesUrlsCommand,
	publicBaseUrl: cfgImagesUrlsPublicBaseUrl,
	ttlHours: cfgImagesUrlsTtlHours,
	bindHost: cfgImagesUrlsBindHost,
	sshTarget: cfgImagesUrlsSshTarget,
	sshRemotePort: cfgImagesUrlsSshRemotePort,
});
