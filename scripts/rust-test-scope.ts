import * as path from "node:path";

export interface CargoMetadataForRustScope {
	packages: CargoMetadataPackageForRustScope[];
	workspace_members: string[];
}

interface CargoMetadataPackageForRustScope {
	id: string;
	name: string;
	version: string;
	source: string | null;
	manifest_path: string;
	dependencies: { name: string }[];
}

export interface CargoLockPackageForRustScope {
	name: string;
	version: string;
	source?: string;
	dependencies?: string[];
}

export interface RustTestScope {
	kind: "none" | "affected" | "all";
	crates: string[];
}

const SHARED_RUST_CONFIG_PATHS: Record<string, true> = {
	"Cargo.toml": true,
	"Cargo.lock": true,
	"rust-toolchain": true,
	"rust-toolchain.toml": true,
	"clippy.toml": true,
	".clippy.toml": true,
	"rustfmt.toml": true,
	".rustfmt.toml": true,
	".config/nextest.toml": true,
};

export function parseFulltestChangedPaths(value: string | undefined): string[] {
	if (value === undefined) {
		throw new Error("OMP_FULLTEST_CHANGED_PATHS is required with --affected.");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("OMP_FULLTEST_CHANGED_PATHS must be a JSON string array.");
	}
	if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string")) {
		throw new Error("OMP_FULLTEST_CHANGED_PATHS must be a JSON string array.");
	}
	return [...new Set(parsed)];
}

export function selectRustTestScope(
	changedPaths: readonly string[],
	metadata: CargoMetadataForRustScope,
	repoRoot: string,
	excludedCrateNames: readonly string[],
	lockPackages?: readonly CargoLockPackageForRustScope[] | null,
): RustTestScope {
	const members = workspaceMembers(metadata, repoRoot);
	if (changedPaths.length === 0) return { kind: "none", crates: [] };

	let selectAll = false;
	const selectedIds = new Set<string>();
	const vendorChanges = new Set<string>();

	for (const changedPath of changedPaths) {
		const normalized = normalizeChangedPath(changedPath);
		if (
			normalized === null ||
			isSharedRustConfigPath(normalized) ||
			normalized === "crates" ||
			(normalized.endsWith(".rs") && !normalized.startsWith("crates/"))
		) {
			selectAll = true;
			break;
		}
		if (!normalized.startsWith("crates/")) continue;

		// Documentation filtering is fulltest's job (isDocumentation). Here every
		// path under an owned crate selects it, so compile-time payloads such as
		// pi-edit's include_str! prompts can never be skipped as "docs".
		const owner = members
			.filter(member => normalized === member.root || normalized.startsWith(`${member.root}/`))
			.sort((left, right) => right.root.length - left.root.length)[0];
		if (owner === undefined) {
			// A removed/renamed workspace crate no longer appears in metadata.
			// A new unregistered crate path is equally unsafe to silently ignore.
			selectAll = true;
			break;
		}
		selectedIds.add(owner.id);
		if (owner.root.startsWith("crates/vendor/")) vendorChanges.add(owner.id);
	}

	const dependentsByDependency = new Map<string, Set<string>>();
	const packagesByName = new Map<string, string[]>();
	for (const member of members) {
		const packages = packagesByName.get(member.name) ?? [];
		packages.push(member.id);
		packagesByName.set(member.name, packages);
	}
	for (const member of members) {
		for (const dependency of member.dependencies) {
			for (const dependencyId of packagesByName.get(dependency.name) ?? []) {
				if (dependencyId === member.id) continue;
				const dependents = dependentsByDependency.get(dependencyId) ?? new Set<string>();
				dependents.add(member.id);
				dependentsByDependency.set(dependencyId, dependents);
			}
		}
	}

	if (!selectAll) {
		// Only the changed crates are test targets — consumer crates without
		// changes are not selected. Vendored crates are the exception: they are
		// excluded from the gate themselves, so their consumers are the closest
		// test surface for the change.
		for (const vendorId of vendorChanges) {
			const vendorClosure = new Set([vendorId]);
			const vendorQueue = [vendorId];
			for (let index = 0; index < vendorQueue.length; index += 1) {
				for (const dependentId of dependentsByDependency.get(vendorQueue[index]!) ?? []) {
					if (vendorClosure.has(dependentId)) continue;
					vendorClosure.add(dependentId);
					vendorQueue.push(dependentId);
				}
			}

			// Metadata omits resolved external package edges; Cargo.lock completes
			// the vendor consumer closure without invoking Cargo a second time.
			const lockConsumers =
				lockPackages !== undefined && lockPackages !== null
					? workspaceConsumersFromLock(vendorId, members, lockPackages)
					: null;
			if (
				lockPackages === null ||
				(lockPackages !== undefined &&
					(lockPackages.length === 0 || lockConsumers === null || lockConsumers.size === 0)) ||
				(vendorClosure.size === 1 && lockConsumers === null)
			) {
				selectAll = true;
				break;
			}
			for (const consumerId of lockConsumers ?? []) vendorClosure.add(consumerId);
			if (vendorClosure.size === 1) {
				selectAll = true;
				break;
			}
			for (const packageId of vendorClosure) selectedIds.add(packageId);
		}
	}

	if (selectAll) {
		for (const member of members) selectedIds.add(member.id);
	}

	const crates = members
		.filter(member => selectedIds.has(member.id) && !excludedCrateNames.includes(member.name))
		.map(member => member.name)
		.sort();
	return { kind: selectAll ? "all" : crates.length === 0 ? "none" : "affected", crates };
}

interface WorkspaceMember {
	id: string;
	name: string;
	version: string;
	source: string | null;
	root: string;
	dependencies: { name: string }[];
}

function workspaceMembers(metadata: CargoMetadataForRustScope, repoRoot: string): WorkspaceMember[] {
	if (!Array.isArray(metadata.packages) || !Array.isArray(metadata.workspace_members)) {
		throw new Error("cargo metadata returned an invalid workspace package list.");
	}
	const memberIds = new Set(metadata.workspace_members);
	const normalizedRepoRoot = repoRoot.replaceAll("\\", "/").replace(/\/$/, "");
	const members = metadata.packages
		.filter(pkg => memberIds.has(pkg.id))
		.map(pkg => {
			if (
				typeof pkg.id !== "string" ||
				typeof pkg.name !== "string" ||
				typeof pkg.version !== "string" ||
				(pkg.source !== null && typeof pkg.source !== "string") ||
				typeof pkg.manifest_path !== "string" ||
				!Array.isArray(pkg.dependencies) ||
				pkg.dependencies.some(dependency => typeof dependency?.name !== "string")
			) {
				throw new Error("cargo metadata returned an invalid workspace package.");
			}
			const manifest = pkg.manifest_path.replaceAll("\\", "/").replace(/\/$/, "");
			if (!manifest.endsWith("/Cargo.toml")) {
				throw new Error(`cargo metadata returned an unexpected manifest path: ${pkg.manifest_path}`);
			}
			const absoluteRoot = manifest.slice(0, -"/Cargo.toml".length);
			const relativeRoot = path.posix.relative(normalizedRepoRoot, absoluteRoot);
			return {
				id: pkg.id,
				name: pkg.name,
				version: pkg.version,
				source: pkg.source,
				root: relativeRoot,
				dependencies: pkg.dependencies,
			};
		});
	if (members.length !== memberIds.size) {
		throw new Error("cargo metadata omitted one or more workspace member packages.");
	}
	return members;
}

function isSharedRustConfigPath(normalized: string): boolean {
	return SHARED_RUST_CONFIG_PATHS[normalized] === true || normalized.startsWith(".cargo/") || normalized === ".cargo";
}

function normalizeChangedPath(changedPath: string): string | null {
	const normalized = changedPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
	if (normalized === "" || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
	const segments = normalized.split("/");
	if (segments.some(segment => segment === ".." || segment === "." || segment === "")) return null;
	return normalized;
}

interface CargoLockNode {
	id: number;
	pkg: CargoLockPackageForRustScope;
}

interface CargoLockDependencySpec {
	name: string;
	version?: string;
	source?: string;
}

function workspaceConsumersFromLock(
	vendorId: string,
	members: readonly WorkspaceMember[],
	lockPackages: readonly CargoLockPackageForRustScope[],
): Set<string> | null {
	const nodesByIdentity = new Map<string, CargoLockNode>();
	const nodesByName = new Map<string, CargoLockNode[]>();
	const nodes = lockPackages.map((pkg, id) => {
		if (
			typeof pkg.name !== "string" ||
			typeof pkg.version !== "string" ||
			(pkg.source !== undefined && typeof pkg.source !== "string") ||
			(pkg.dependencies !== undefined &&
				(!Array.isArray(pkg.dependencies) || pkg.dependencies.some(dependency => typeof dependency !== "string")))
		) {
			return null;
		}
		const node = { id, pkg };
		const identity = cargoPackageIdentity(pkg.name, pkg.version, pkg.source);
		if (nodesByIdentity.has(identity)) return null;
		nodesByIdentity.set(identity, node);
		const sameName = nodesByName.get(pkg.name) ?? [];
		sameName.push(node);
		nodesByName.set(pkg.name, sameName);
		return node;
	});
	if (nodes.some(node => node === null)) return null;

	const workspaceMemberByLockNode = new Map<number, string>();
	for (const member of members) {
		const node = nodesByIdentity.get(cargoPackageIdentity(member.name, member.version, member.source));
		if (node === undefined) return null;
		workspaceMemberByLockNode.set(node.id, member.id);
	}

	const vendorMember = members.find(member => member.id === vendorId);
	if (vendorMember === undefined) return null;
	const vendorNode = nodesByIdentity.get(
		cargoPackageIdentity(vendorMember.name, vendorMember.version, vendorMember.source),
	);
	if (vendorNode === undefined) return null;

	const dependentsByDependency = new Map<number, Set<number>>();
	for (const node of nodes) {
		if (node === null) return null;
		for (const dependency of node.pkg.dependencies ?? []) {
			const spec = parseCargoLockDependency(dependency);
			if (spec === null) return null;
			const candidates = (nodesByName.get(spec.name) ?? []).filter(
				candidate =>
					(spec.version === undefined || candidate.pkg.version === spec.version) &&
					(spec.source === undefined || candidate.pkg.source === spec.source),
			);
			if (candidates.length === 0) return null;
			for (const candidate of candidates) {
				const dependents = dependentsByDependency.get(candidate.id) ?? new Set<number>();
				dependents.add(node.id);
				dependentsByDependency.set(candidate.id, dependents);
			}
		}
	}

	const consumers = new Set<string>();
	const visited = new Set([vendorNode.id]);
	const queue = [vendorNode.id];
	for (let index = 0; index < queue.length; index += 1) {
		for (const dependentId of dependentsByDependency.get(queue[index]!) ?? []) {
			if (visited.has(dependentId)) continue;
			visited.add(dependentId);
			queue.push(dependentId);
			const memberId = workspaceMemberByLockNode.get(dependentId);
			if (memberId !== undefined && memberId !== vendorId) consumers.add(memberId);
		}
	}
	return consumers;
}

function cargoPackageIdentity(name: string, version: string, source: string | null | undefined): string {
	return `${name}\0${version}\0${source ?? ""}`;
}

function parseCargoLockDependency(value: string): CargoLockDependencySpec | null {
	const sourceStart = value.indexOf(" (");
	let coordinates = value;
	let source: string | undefined;
	if (sourceStart >= 0) {
		if (!value.endsWith(")")) return null;
		coordinates = value.slice(0, sourceStart);
		source = value.slice(sourceStart + 2, -1);
	}
	const parts = coordinates.split(/\s+/);
	if (parts.length < 1 || parts.length > 2 || parts[0] === "") return null;
	return {
		name: parts[0]!,
		...(parts[1] === undefined ? {} : { version: parts[1] }),
		...(source === undefined ? {} : { source }),
	};
}
