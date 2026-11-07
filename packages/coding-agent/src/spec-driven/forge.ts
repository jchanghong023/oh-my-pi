import { github } from "../utils/github";
import { gitlab } from "../utils/gitlab";
import type { DevGitTarget, DevPrFact, DevPrRef } from "./types";

export interface DevForgeServiceOptions {
	cwd: string;
	githubRunner?: typeof github;
	gitlabRunner?: typeof gitlab;
}

interface Repository {
	host: string;
	project: string;
}
function localRepository(value: string): boolean {
	return /^[\\/]|^[A-Za-z]:[\\/]|^file:\/\//.test(value);
}
function repository(value: string): Repository {
	if (localRepository(value))
		throw new Error("A local Git remote does not identify an authorized GitHub or GitLab repository");
	const ssh = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(value);
	let host: string;
	let project: string;
	if (value.includes("://")) {
		const url = new URL(value);
		host = url.host;
		project = url.pathname.slice(1);
	} else if (ssh && value.includes("@")) {
		host = ssh[1];
		project = ssh[2];
	} else {
		const parts = value.split("/");
		host = parts[0].includes(".") ? parts.shift()! : "github.com";
		project = parts.join("/");
	}
	project = project.replace(/\.git$/, "").replace(/\/$/, "");
	if (!host || project.split("/").length < 2 || /[\s?#]/.test(project))
		throw new Error(`Invalid Forge repository: ${value}`);
	return { host: host.toLowerCase(), project };
}
export function devRepositoryIdentity(value: string): string {
	if (localRepository(value)) return value.replaceAll("\\", "/");
	const parsed = repository(value);
	return `${parsed.host}/${parsed.host.includes("github") ? parsed.project.toLowerCase() : parsed.project}`;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Forge returned an invalid object");
	return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) throw new Error(`Forge did not return ${field}`);
	return value;
}
function number(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
		throw new Error("Forge did not return PR number");
	return value;
}
function branch(ref: string): string {
	return ref.replace(/^refs\/heads\//, "");
}
function githubFact(value: unknown, identity: string): DevPrFact {
	const data = object(value);
	const head = object(data.head);
	const base = object(data.base);
	const state =
		data.merged === true ? "merged" : data.state === "open" ? "open" : data.state === "closed" ? "closed" : null;
	if (!state) throw new Error("GitHub did not return a definite PR state");
	return {
		pr: {
			forge: "github",
			repository: identity,
			number: number(data.number),
			url: text(data.html_url, "PR URL"),
			sourceRef: text(head.ref, "source ref"),
			baseRef: text(base.ref, "base ref"),
		},
		state,
		headSha: text(head.sha, "head SHA"),
		baseSha: text(base.sha, "base SHA"),
		mergeSha: state === "merged" ? text(data.merge_commit_sha, "merge SHA") : null,
		observedAt: new Date().toISOString(),
	};
}
function gitlabFact(value: unknown, identity: string): DevPrFact {
	const data = object(value);
	const refs = object(data.diff_refs);
	const state =
		data.state === "opened" ? "open" : data.state === "merged" ? "merged" : data.state === "closed" ? "closed" : null;
	if (!state) throw new Error("GitLab did not return a definite merge request state");
	return {
		pr: {
			forge: "gitlab",
			repository: identity,
			number: number(data.iid),
			url: text(data.web_url, "PR URL"),
			sourceRef: text(data.source_branch, "source ref"),
			baseRef: text(data.target_branch, "base ref"),
		},
		state,
		headSha: text(data.sha ?? refs.head_sha, "head SHA"),
		baseSha: text(refs.base_sha, "base SHA"),
		mergeSha: state === "merged" ? text(data.merge_commit_sha ?? data.squash_commit_sha, "merge SHA") : null,
		observedAt: new Date().toISOString(),
	};
}

/** Exact repository/ref operations; no checkout, branch creation, or merge inference. */
export class DevForgeService {
	readonly #cwd: string;
	readonly #github: typeof github;
	readonly #gitlab: typeof gitlab;
	constructor(options: DevForgeServiceOptions) {
		this.#cwd = options.cwd;
		this.#github = options.githubRunner ?? github;
		this.#gitlab = options.gitlabRunner ?? gitlab;
	}
	async #api(
		forge: DevPrRef["forge"],
		repo: Repository,
		endpoint: string,
		args: string[],
		signal: AbortSignal,
	): Promise<unknown> {
		signal.throwIfAborted();
		const runner = forge === "github" ? this.#github : this.#gitlab;
		return runner.json<unknown>(this.#cwd, ["api", "--hostname", repo.host, endpoint, ...args], signal);
	}
	async observeDevPr(pr: DevPrRef, signal: AbortSignal): Promise<DevPrFact> {
		const repo = repository(pr.repository);
		const endpoint =
			pr.forge === "github"
				? `repos/${repo.project}/pulls/${pr.number}`
				: `projects/${encodeURIComponent(repo.project)}/merge_requests/${pr.number}`;
		const value = await this.#api(pr.forge, repo, endpoint, [], signal);
		const fact =
			pr.forge === "github"
				? githubFact(value, `${repo.host}/${repo.project}`)
				: gitlabFact(value, `${repo.host}/${repo.project}`);
		if (pr.forge === "gitlab") {
			const currentBase = object(
				await this.#api(
					pr.forge,
					repo,
					`projects/${encodeURIComponent(repo.project)}/repository/branches/${encodeURIComponent(branch(pr.baseRef))}`,
					[],
					signal,
				),
			);
			fact.baseSha = text(object(currentBase.commit).id, "actual target branch SHA");
		}
		if (branch(fact.pr.sourceRef) !== branch(pr.sourceRef) || branch(fact.pr.baseRef) !== branch(pr.baseRef))
			throw new Error("Observed PR source/base no longer matches the confirmed PR");
		return fact;
	}
	async createDevPr(
		input: { requirementId: string; target: DevGitTarget; title: string; body: string },
		signal: AbortSignal,
	): Promise<DevPrFact> {
		const base = repository(input.target.baseRepository);
		const source = repository(input.target.sourceRepository);
		if (base.host !== source.host) throw new Error("PR source and base must use the same Forge host");
		let forge: DevPrRef["forge"];
		if (base.host === "github.com" || base.host.includes("github")) forge = "github";
		else if (base.host === "gitlab.com" || base.host.includes("gitlab")) forge = "gitlab";
		else {
			try {
				await this.#api("github", base, `repos/${base.project}`, [], signal);
				forge = "github";
			} catch (githubError) {
				try {
					await this.#api("gitlab", base, `projects/${encodeURIComponent(base.project)}`, [], signal);
					forge = "gitlab";
				} catch (gitlabError) {
					throw new AggregateError(
						[githubError, gitlabError],
						"No authorized GitHub/GitLab repository could be established for this host",
					);
				}
			}
		}
		const marker = `<!-- omp-requirement:${input.requirementId} -->`;
		const sourceBranch = branch(input.target.sourceRef);
		const baseBranch = branch(input.target.baseRef);
		const endpoint =
			forge === "github"
				? `repos/${base.project}/pulls`
				: `projects/${encodeURIComponent(base.project)}/merge_requests`;
		let sourceProjectId: number | null = null;
		let baseProjectId: number | null = null;
		if (forge === "gitlab") {
			sourceProjectId = number(
				object(await this.#api(forge, source, `projects/${encodeURIComponent(source.project)}`, [], signal)).id,
			);
			baseProjectId = number(
				object(await this.#api(forge, base, `projects/${encodeURIComponent(base.project)}`, [], signal)).id,
			);
		}
		const find = async (lookupSignal: AbortSignal): Promise<DevPrFact | null> => {
			const query =
				forge === "github"
					? `?state=all&head=${encodeURIComponent(`${source.project.split("/")[0]}:${sourceBranch}`)}&base=${encodeURIComponent(baseBranch)}&per_page=100`
					: `?state=all&source_branch=${encodeURIComponent(sourceBranch)}&target_branch=${encodeURIComponent(baseBranch)}&per_page=100`;
			const result: unknown[] = [];
			for (let page = 1; ; page++) {
				const values = await this.#api(
					forge,
					base,
					`${endpoint}${query}${page === 1 ? "" : `&page=${page}`}`,
					[],
					lookupSignal,
				);
				if (!Array.isArray(values)) throw new Error("Forge PR lookup did not return a list");
				result.push(...values);
				if (values.length < 100) break;
			}
			const matches = result.filter(value => {
				const item = object(value);
				if (forge === "gitlab")
					return (
						item.source_project_id === sourceProjectId &&
						item.source_branch === sourceBranch &&
						item.target_branch === baseBranch &&
						typeof item.description === "string" &&
						item.description.includes(marker)
					);
				const head = object(item.head);
				const target = object(item.base);
				const sourceRepo = object(head.repo);
				return (
					head.ref === sourceBranch &&
					target.ref === baseBranch &&
					typeof sourceRepo.full_name === "string" &&
					sourceRepo.full_name.toLowerCase() === source.project.toLowerCase() &&
					typeof item.body === "string" &&
					item.body.includes(marker)
				);
			});
			if (matches.length > 1)
				throw new Error("Multiple PRs match this exact requirement/source/base; choose an existing PR explicitly");
			if (!matches.length) return null;
			const item = object(matches[0]);
			return this.observeDevPr(
				{
					forge,
					repository: `${base.host}/${base.project}`,
					number: number(forge === "github" ? item.number : item.iid),
					url: text(forge === "github" ? item.html_url : item.web_url, "PR URL"),
					sourceRef: sourceBranch,
					baseRef: baseBranch,
				},
				lookupSignal,
			);
		};
		const existing = await find(signal);
		if (existing) return existing;
		const fields =
			forge === "github"
				? [
						"--method",
						"POST",
						"-f",
						`title=${input.title}`,
						"-f",
						`body=${input.body}\n\n${marker}`,
						"-f",
						`head=${source.project.split("/")[0]}:${sourceBranch}`,
						"-f",
						`base=${baseBranch}`,
					]
				: [
						"--method",
						"POST",
						"-f",
						`title=${input.title}`,
						"-f",
						`description=${input.body}\n\n${marker}`,
						"-f",
						`source_branch=${sourceBranch}`,
						"-f",
						`target_branch=${baseBranch}`,
						"-F",
						`target_project_id=${baseProjectId}`,
					];
		try {
			const createEndpoint =
				forge === "github" ? endpoint : `projects/${encodeURIComponent(source.project)}/merge_requests`;
			const created = object(
				await this.#api(forge, forge === "github" ? base : source, createEndpoint, fields, signal),
			);
			return await this.observeDevPr(
				{
					forge,
					repository: `${base.host}/${base.project}`,
					number: number(forge === "github" ? created.number : created.iid),
					url: text(forge === "github" ? created.html_url : created.web_url, "PR URL"),
					sourceRef: sourceBranch,
					baseRef: baseBranch,
				},
				signal,
			);
		} catch (error) {
			const observed = await find(AbortSignal.timeout(30_000)).catch(() => null);
			if (observed) return observed;
			throw error;
		}
	}
	async closeDevPr(pr: DevPrRef, signal: AbortSignal): Promise<DevPrFact> {
		const before = await this.observeDevPr(pr, signal);
		if (before.state !== "open") return before;
		const repo = repository(pr.repository);
		const endpoint =
			pr.forge === "github"
				? `repos/${repo.project}/pulls/${pr.number}`
				: `projects/${encodeURIComponent(repo.project)}/merge_requests/${pr.number}`;
		let failure: unknown;
		try {
			await this.#api(
				pr.forge,
				repo,
				endpoint,
				[
					"--method",
					pr.forge === "github" ? "PATCH" : "PUT",
					"-f",
					pr.forge === "github" ? "state=closed" : "state_event=close",
				],
				signal,
			);
		} catch (error) {
			failure = error;
		}
		const after = await this.observeDevPr(pr, AbortSignal.timeout(30_000));
		if (after.state === "open") throw failure ?? new Error("Forge did not close the PR");
		return after;
	}
}
