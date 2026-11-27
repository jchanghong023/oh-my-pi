/** Manual self-update for standalone OMP binaries published to CNB. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	$which,
	APP_NAME,
	compareVersions,
	formatBytes,
	isCompiledBinary,
	isEnoent,
	isRecord,
	logger,
	offlineFromEnv,
	pathIsWithinLexical,
	SEMVER_RE,
	WhichCachePolicy,
} from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { $ } from "bun";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";
import { BUILD_DOWNLOAD_TIMEOUT_MS, currentBuildHost, downloadBuildFile, type Fetch } from "./build-service";
import { managedInstallName } from "./managed-install";

const DEFAULT_REPOSITORY = "jchanghong/bin";
const DEFAULT_TAG = "omp";
const CNB_API = "https://api.cnb.cool";
const CNB_RELEASES_PAGE = `https://cnb.cool/${DEFAULT_REPOSITORY}/-/releases`;
const CNB_MEDIA_TYPE = "application/vnd.cnb.api+json";
const CNB_AUTH_HELP = "Set CNB_TOKEN to a CNB access token with repo-release:r permission.";
const METADATA_TIMEOUT_MS = 30_000;

export type UpdateProgress =
	| { phase: "downloading"; version: string; received: number; total: number }
	| { phase: "installing"; version: string };

export interface UpdateOptions {
	force: boolean;
	check: boolean;
	onProgress?: (progress: UpdateProgress) => void;
}

export type UpdateOutcome =
	| { kind: "current" }
	| { kind: "available"; version: string }
	| { kind: "unsupported"; reason: string }
	| { kind: "installed"; version: string };

interface CnbReleaseAsset {
	version: string;
	size: number;
	sha256: string;
}

function semver(value: string): string | undefined {
	const version = value.startsWith("v") ? value.slice(1) : value;
	return version.length <= 128 && SEMVER_RE.test(version) ? version : undefined;
}

export function parseReportedVersion(output: string): string | undefined {
	const prefix = `${APP_NAME}/`;
	if (!output.startsWith(prefix)) return undefined;
	const version = output.slice(prefix.length);
	return version.length <= 128 && SEMVER_RE.test(version) ? version : undefined;
}

/** Compare SemVer precedence, then the fork build counter (absent means zero). */
export function compareUpdateVersions(left: string, right: string): number {
	const precedence = compareVersions(left, right);
	if (precedence !== 0) return precedence;
	const leftRun = BigInt(/\+fork\.(\d+)$/.exec(left)?.[1] ?? "0");
	const rightRun = BigInt(/\+fork\.(\d+)$/.exec(right)?.[1] ?? "0");
	return leftRun < rightRun ? -1 : leftRun > rightRun ? 1 : 0;
}

/** Validate the release and require its single asset for this platform. */
export function parseCnbRelease(body: unknown, tag: string, binaryName: string): CnbReleaseAsset {
	if (!isRecord(body) || body.tag_name !== tag || body.draft === true || body.prerelease === true) {
		throw new Error("CNB returned a mismatched, draft, or prerelease release.");
	}
	const name = typeof body.name === "string" ? body.name : "";
	const annotated = / \[omp:(v[^\]]+)\]$/.exec(name)?.[1];
	const titleVersion = semver(annotated ?? name);
	const tagVersion = semver(tag);
	const version = titleVersion ?? tagVersion;
	if (
		!version ||
		(annotated !== undefined && !titleVersion) ||
		(tagVersion && titleVersion && tagVersion !== titleVersion)
	) {
		throw new Error(
			"CNB release has no matching OMP version. Ask the release maintainer to publish version metadata.",
		);
	}
	if (version.split("+", 1)[0]!.includes("-")) throw new Error(`CNB release ${version} is not a stable build.`);
	let asset: Record<string, unknown> | undefined;
	for (const entry of Array.isArray(body.assets) ? body.assets : []) {
		if (!isRecord(entry) || entry.name !== binaryName) continue;
		if (asset) throw new Error(`CNB release contains more than one ${binaryName} asset.`);
		asset = entry;
	}
	if (!asset) throw new Error(`CNB release does not contain ${binaryName}.`);
	const { size, hash_algo: algorithm, hash_value: hash } = asset;
	if (
		typeof size !== "number" ||
		!Number.isSafeInteger(size) ||
		size <= 0 ||
		typeof algorithm !== "string" ||
		!/^(?:sha256|sha-256)$/i.test(algorithm) ||
		typeof hash !== "string" ||
		!/^[a-f0-9]{64}$/i.test(hash)
	) {
		throw new Error(`CNB release asset ${binaryName} lacks a valid SHA-256 digest or size.`);
	}
	return { version, size, sha256: hash.toLowerCase() };
}

function releaseSource(): { base: string; tag: string } {
	const [repo = DEFAULT_REPOSITORY, tag = DEFAULT_TAG, extra] = (
		process.env.PI_UPDATE_REPOSITORY || DEFAULT_REPOSITORY
	).split("@");
	if (
		extra !== undefined ||
		!/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/.test(repo) ||
		repo.endsWith(".git") ||
		!/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(tag) ||
		tag.includes("..") ||
		tag.includes("//") ||
		tag.endsWith("/")
	) {
		throw new Error("Invalid CNB update source; expected owner/repository[@tag].");
	}
	return { base: `${CNB_API}/${repo}/-/releases`, tag };
}

async function fetchCnbApi(url: string): Promise<Response> {
	const token = process.env.CNB_TOKEN?.trim();
	if (!token) throw new Error(CNB_AUTH_HELP);
	const init: BunFetchRequestInit = {
		headers: { Accept: CNB_MEDIA_TYPE, Authorization: `Bearer ${token}` },
		redirect: "manual",
		signal: withTimeoutSignal(METADATA_TIMEOUT_MS),
		tls: { rejectUnauthorized: true },
	};
	const response = await fetch(url, init);
	if (response.status === 401 || response.status === 403) {
		throw new Error(`CNB rejected access (HTTP ${response.status}). ${CNB_AUTH_HELP}`);
	}
	return response;
}

async function fetchRelease(base: string, tag: string, binaryName: string): Promise<CnbReleaseAsset> {
	const response = await fetchCnbApi(`${base}/tags/${encodeURIComponent(tag)}`);
	if (!response.ok) throw new Error(`CNB release metadata request failed (HTTP ${response.status}).`);
	return parseCnbRelease(await response.json(), tag, binaryName);
}

async function resolveDownload(base: string, tag: string, binaryName: string): Promise<string> {
	const response = await fetchCnbApi(`${base}/download/${encodeURIComponent(tag)}/${binaryName}`);
	if (response.status !== 302) {
		throw new Error(`CNB asset request did not return a download redirect (HTTP ${response.status}).`);
	}
	const location = response.headers.get("location");
	if (!location || !URL.canParse(location)) throw new Error("CNB did not return a valid download URL.");
	const url = new URL(location);
	if (url.protocol !== "https:" || url.username || url.password)
		throw new Error("CNB returned an unsafe download URL.");
	return url.href;
}

async function binaryNameForHost(): Promise<string | undefined> {
	if (process.arch !== "x64") return undefined;
	if (process.platform === "win32") return "omp-windows-x64.exe";
	if (process.platform === "linux" && (await currentBuildHost()).asset === "linux-x64") return "omp-linux-x64";
	return undefined;
}

function normalizedPath(file: string): string {
	const resolved = path.resolve(file);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function physicalPath(file: string): Promise<string> {
	try {
		return await fs.realpath(file);
	} catch {
		return file;
	}
}

async function managerFor(target: string): Promise<string | undefined> {
	const manager = await managedInstallName(target);
	if (manager) return manager;
	const normalized = normalizedPath(target);
	const parts = normalized.split(path.sep);
	if (parts.includes("node_modules")) return "a package manager";
	if (process.platform === "linux" && pathIsWithinLexical("/nix/store", normalized)) return "Nix";
	if (parts.some((part, index) => part.toLowerCase() === "cellar" && parts[index + 1] === APP_NAME)) return "Homebrew";
	if (process.platform === "win32" && parts.some((part, index) => part === "apps" && parts[index + 1] === APP_NAME))
		return "Scoop";
	const dataHome =
		process.platform === "win32" && process.env.LOCALAPPDATA
			? process.env.LOCALAPPDATA
			: process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
	const miseData = process.env.MISE_DATA_DIR || path.join(dataHome, "mise");
	const miseInstalls = process.env.MISE_INSTALLS_DIR || path.join(miseData, "installs");
	if (pathIsWithinLexical(normalizedPath(miseInstalls), normalized)) return "mise";
	return undefined;
}

async function reportedVersion(file: string): Promise<string | undefined> {
	try {
		const result = await $`${file} --version`.quiet().nothrow();
		return result.exitCode === 0 ? parseReportedVersion(result.text().trim()) : undefined;
	} catch {
		return undefined;
	}
}

export function warnOnPathConflict(targetPath: string, ompPath: string | undefined): void {
	if (!ompPath || normalizedPath(targetPath) === normalizedPath(ompPath)) return;
	console.log(
		chalk.yellow(
			`Warning: ${APP_NAME} resolves to ${ompPath} in PATH, not update target ${targetPath}. ` +
				`Run \`${APP_NAME} --version\` to confirm which binary is active.`,
		),
	);
}

/** Synchronize Browser Relay assets from the verified OMP launcher. */
export async function syncRelayAfterVerifiedUpdate(launcher: string | undefined): Promise<void> {
	if (!launcher) return;
	try {
		const result = await $`${launcher} browser-relay sync`.quiet().nothrow();
		if (result.exitCode !== 0) {
			logger.warn("browser relay sync after update failed", {
				launcher,
				exitCode: result.exitCode,
				error: result.stderr.toString().trim(),
			});
		}
	} catch (error) {
		logger.warn("browser relay sync after update failed", { launcher, error: String(error) });
	}
}

async function removeBackup(file: string): Promise<void> {
	try {
		await fs.unlink(file);
	} catch (error) {
		if (!isEnoent(error)) logger.debug("Update artifact retained", { file, ...logger.diagnosticError(error) });
	}
}

export async function sweepStaleUpdateArtifacts(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const prefix = `${path.basename(targetPath)}.`;
	try {
		for (const entry of await fs.readdir(dir)) {
			if (!entry.startsWith(prefix)) continue;
			const suffix = entry.slice(prefix.length);
			if (suffix === "patch" || !/^(?:\d+(?:\.\d+)*\.)?(?:bak|new(?:\.exe)?|patch)$/.test(suffix)) continue;
			const file = path.join(dir, entry);
			try {
				if (!suffix.endsWith("bak") && Date.now() - (await fs.stat(file)).mtimeMs < BUILD_DOWNLOAD_TIMEOUT_MS)
					continue;
				await removeBackup(file);
			} catch (error) {
				if (!isEnoent(error)) logger.debug("Update artifact retained", { file, ...logger.diagnosticError(error) });
			}
		}
	} catch (error) {
		if (!isEnoent(error)) logger.debug("Could not scan update artifacts", { dir, ...logger.diagnosticError(error) });
	}
}

async function swapBinary(target: string, candidate: string, backup: string): Promise<void> {
	if (process.platform !== "win32") {
		await fs.rename(candidate, target); // POSIX replaces the old inode atomically, without stopping its users.
		return;
	}
	await fs.rename(target, backup);
	try {
		await fs.rename(candidate, target);
	} catch (error) {
		try {
			// Never overwrite a new target created by another process during the failure.
			await fs.link(backup, target);
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				`Could not restore ${target}; previous binary retained at ${backup}.`,
			);
		}
		await removeBackup(backup);
		throw error;
	}
	await removeBackup(backup); // The updating Windows process may still have its old image mapped.
}

interface InstallCnbOptions extends Pick<UpdateOptions, "force" | "onProgress"> {
	url: string;
	asset: CnbReleaseAsset;
	fetchImpl?: Fetch;
}

let attemptSequence = 0;

/** Download and verify in the target directory; never execute bytes with the wrong hash. */
export async function installCnbBinary(targetPath: string, opts: InstallCnbOptions): Promise<boolean> {
	const { version, sha256, size } = opts.asset;
	const attempt = `${targetPath}.${Date.now()}.${process.pid}.${attemptSequence++}`;
	const candidate = `${attempt}.new${process.platform === "win32" ? ".exe" : ""}`;
	const progress = process.stdout.isTTY;
	try {
		await downloadBuildFile({
			// Keep the short-lived signed URL out of downloader errors and diagnostics.
			url: CNB_RELEASES_PAGE,
			targetPath: candidate,
			size,
			sha256,
			fetchImpl: async (_input, init) => {
				try {
					return await (opts.fetchImpl ?? fetch)(opts.url, { ...init, redirect: "error" });
				} catch (error) {
					if (isTimeoutError(error)) throw new DOMException("CNB binary download timed out.", "TimeoutError");
					throw new Error("Could not download the CNB binary.");
				}
			},
			onProgress(received) {
				opts.onProgress?.({ phase: "downloading", version, received, total: size });
				if (progress) process.stdout.write(`\r  ${formatBytes(received)} / ${formatBytes(size)}    `);
			},
		});
	} finally {
		if (progress) process.stdout.write("\n");
	}
	try {
		await fs.chmod(candidate, 0o755);
		const actual = await reportedVersion(candidate);
		if (actual !== version) throw new Error(`Downloaded OMP reports ${actual ?? "no version"}; expected ${version}.`);
	} catch (error) {
		await removeBackup(candidate);
		throw error;
	}

	const currentVersion = await reportedVersion(targetPath);
	if (!currentVersion) throw new Error(`Could not verify ${targetPath}; verified update retained at ${candidate}.`);
	const comparison = compareUpdateVersions(version, currentVersion);
	if (comparison < 0 || (comparison === 0 && !opts.force)) {
		await removeBackup(candidate);
		return false;
	}
	opts.onProgress?.({ phase: "installing", version });
	try {
		await swapBinary(targetPath, candidate, `${attempt}.bak`);
	} catch (error) {
		throw new Error(
			`Could not update ${targetPath}; verified update retained at ${candidate}. ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	return true;
}

function unsupported(reason: string, suggestInstaller = true): UpdateOutcome {
	console.log(chalk.yellow(reason));
	if (suggestInstaller)
		console.log(chalk.dim(`Use this fork's installer for a standalone binary: ${CNB_RELEASES_PAGE}`));
	return { kind: "unsupported", reason };
}

function alreadyCurrent(): UpdateOutcome {
	console.log(chalk.green("Already up to date"));
	return { kind: "current" };
}

export async function runUpdateCommand(opts: UpdateOptions): Promise<UpdateOutcome> {
	if (offlineFromEnv()) throw new Error("OMP cannot check for or install updates in offline mode.");
	const binaryName = await binaryNameForHost();
	if (!binaryName) return unsupported("CNB updates require Linux glibc x64 or Windows x64.", false);
	if (!isCompiledBinary()) return unsupported("Only standalone OMP binaries can update themselves.");
	const target = await fs.realpath(process.execPath);
	const manager = await managerFor(target);
	if (manager) return unsupported(`This installation is managed by ${manager}.`);
	const launcher = $which(APP_NAME, { cache: WhichCachePolicy.Fresh }) ?? undefined;
	warnOnPathConflict(target, launcher && (await physicalPath(launcher)));

	const update = async (): Promise<UpdateOutcome> => {
		const currentVersion = await reportedVersion(target);
		if (!currentVersion) return unsupported(`The update target ${target} does not report an OMP version.`);
		console.log(chalk.dim(`Current version: ${currentVersion}`));
		const source = releaseSource();
		let asset: CnbReleaseAsset;
		try {
			asset = await fetchRelease(source.base, source.tag, binaryName);
		} catch (error) {
			throw new Error(`Failed to check for updates: ${error instanceof Error ? error.message : String(error)}`, {
				cause: error,
			});
		}
		const comparison = compareUpdateVersions(asset.version, currentVersion);
		if (comparison < 0 || (comparison === 0 && (!opts.force || opts.check))) return alreadyCurrent();
		console.log(
			comparison > 0
				? chalk.cyan(`New version available: ${asset.version}`)
				: chalk.yellow(`Forcing reinstall of ${asset.version}`),
		);
		if (opts.check) return { kind: "available", version: asset.version };

		await sweepStaleUpdateArtifacts(target);
		const url = await resolveDownload(source.base, source.tag, binaryName);
		if (!(await installCnbBinary(target, { ...opts, asset, url }))) return alreadyCurrent();
		const active = $which(APP_NAME, { cache: WhichCachePolicy.Fresh }) ?? undefined;
		const activePath = active ? await physicalPath(active) : undefined;
		console.log(chalk.green(`Updated to ${asset.version} at ${target}`));
		if (
			!active ||
			!activePath ||
			normalizedPath(activePath) !== normalizedPath(target) ||
			(await reportedVersion(active)) !== asset.version
		) {
			console.log(
				chalk.yellow(`The PATH launcher could not be verified. Run \`${APP_NAME} --version\` and check PATH.`),
			);
		} else {
			await syncRelayAfterVerifiedUpdate(active);
		}
		console.log(chalk.dim(`Restart ${APP_NAME} to use the new version.`));
		return { kind: "installed", version: asset.version };
	};
	return opts.check ? update() : withFileLock(target, update);
}
