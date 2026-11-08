import * as os from "node:os";
import type { IFileService } from "../../../../vendor/zcode-frontend/packages/services/src/file/file";
import type { IFileWatcherService } from "../../../../vendor/zcode-frontend/packages/services/src/fileWatcher/fileWatcher";
import type { IGitService } from "../../../../vendor/zcode-frontend/packages/services/src/git/git";
import type { IGitCheckpointService } from "../../../../vendor/zcode-frontend/packages/services/src/git/gitCheckpoint";
import type { IMediaPreviewService } from "../../../../vendor/zcode-frontend/packages/services/src/media-preview/mediaPreview";
import type { IPromptAttachmentTransferService } from "../../../../vendor/zcode-frontend/packages/services/src/prompt-attachment-transfer/promptAttachmentTransfer";
import type { ISystemService } from "../../../../vendor/zcode-frontend/packages/services/src/system/system";
import { ServiceChannels } from "../../../../vendor/zcode-frontend/packages/shared/src/channels";
import type {
	GitRefreshResult,
	GitRepositorySummary,
	GitWorkspaceRepositoryInfo,
} from "../../../../vendor/zcode-frontend/packages/shared/src/git";
import type { SystemInfo } from "../../../../vendor/zcode-frontend/packages/shared/src/protocol";
import {
	type WebGuiMethod,
	WebGuiNotImplementedError,
	type WebGuiServiceContext,
	type WebGuiServiceDefinition,
} from "./rpc-contract";
import { createWebGuiService } from "./service-channel";

function unavailable(feature: string): WebGuiMethod {
	return () => {
		throw new WebGuiNotImplementedError(feature);
	};
}

export function createFileServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	// TODO(omp-git): Connect repository discovery/status. These fields describe this
	// attachment's unavailable Git capability, not a disk scan or a clean repository.
	const repositorySummary = (): GitRepositorySummary => ({
		workspacePath: context.workspacePath ?? "",
		repoRoot: "",
		workspaceInRepoPath: "",
		autoRefreshWatchPaths: [],
		branchName: null,
		trackingBranchName: null,
		// Required discriminator is inactive while isGitAvailable/isRepository are false.
		headRefType: "detached",
		ahead: 0,
		behind: 0,
		isDirty: false,
		isGitAvailable: false,
		isRepository: false,
	});
	const repositoryInfo = (): GitWorkspaceRepositoryInfo => ({
		workspacePath: context.workspacePath ?? "",
		// The kind is inactive while the Git capability is unavailable.
		kind: "not-repository",
		isGitAvailable: false,
	});
	const refresh = (): GitRefreshResult => ({
		summary: repositorySummary(),
		identity: null,
		unstagedChanges: [],
		stagedChanges: [],
		branchComparison: null,
	});

	return [
		createWebGuiService(ServiceChannels.File, {
			// TODO(omp-files): Connect native directory/search/index, path/stat/read,
			// workspace creation and ignore-file editing; do not invent files or paths.
			searchWorkspaceFiles: unavailable("file.searchWorkspaceFiles"),
			readdir: unavailable("file.readdir"),
			stat: unavailable("file.stat"),
			checkFilesExist: unavailable("file.checkFilesExist"),
			resolvePath: unavailable("file.resolvePath"),
			ensureConversationWorkspace: unavailable("file.ensureConversationWorkspace"),
			createDefaultWorkspace: unavailable("file.createDefaultWorkspace"),
			createScratchWorkspace: unavailable("file.createScratchWorkspace"),
			readTextFile: unavailable("file.readTextFile"),
			readMediaPreview: unavailable("file.readMediaPreview"),
			readFileRange: unavailable("file.readFileRange"),
			readBinaryPreview: unavailable("file.readBinaryPreview"),
			listWorkspaceFilesLength: unavailable("file.listWorkspaceFilesLength"),
			listWorkspaceFilesRange: unavailable("file.listWorkspaceFilesRange"),
			readWorkspaceFileSearchIgnore: unavailable("file.readWorkspaceFileSearchIgnore"),
			applyWorkspaceFileSearchIgnoreTransform: unavailable("file.applyWorkspaceFileSearchIgnoreTransform"),
			writeWorkspaceFileSearchIgnore: unavailable("file.writeWorkspaceFileSearchIgnore"),
		} satisfies Record<keyof IFileService, WebGuiMethod>),
		createWebGuiService(ServiceChannels.MediaPreview, {
			// TODO(omp-media): Connect native media authorization, bytes and URL lifecycle.
			prepare: unavailable("media-preview.prepare"),
			refreshPlaybackUrl: unavailable("media-preview.refreshPlaybackUrl"),
			release: unavailable("media-preview.release"),
		} satisfies Record<keyof IMediaPreviewService, WebGuiMethod>),
		createWebGuiService(ServiceChannels.Git, {
			getRepositorySummary: repositorySummary,
			getWorkspaceRepositoryInfo: repositoryInfo,
			refresh,
			// TODO(omp-git): Connect native branch/history/diff/identity reads and Git
			// mutations, including provider-backed commit-message generation.
			getLocalBranches: unavailable("git.getLocalBranches"),
			getCommitGraph: unavailable("git.getCommitGraph"),
			switchBranch: unavailable("git.switchBranch"),
			createBranchAndSwitch: unavailable("git.createBranchAndSwitch"),
			getChanges: unavailable("git.getChanges"),
			getIgnoredPaths: unavailable("git.getIgnoredPaths"),
			getDiff: unavailable("git.getDiff"),
			getBranchComparison: unavailable("git.getBranchComparison"),
			stagePaths: unavailable("git.stagePaths"),
			unstagePaths: unavailable("git.unstagePaths"),
			discardPaths: unavailable("git.discardPaths"),
			generateCommitMessage: unavailable("git.generateCommitMessage"),
			commit: unavailable("git.commit"),
			push: unavailable("git.push"),
			getIdentity: unavailable("git.getIdentity"),
		} satisfies Record<keyof IGitService, WebGuiMethod>),
		createWebGuiService(ServiceChannels.GitCheckpoint, {
			// TODO(omp-git-checkpoints): Connect native checkpoint storage/diff/restore.
			createCheckpoint: unavailable("git-checkpoint.createCheckpoint"),
			diffCheckpoints: unavailable("git-checkpoint.diffCheckpoints"),
			restoreBetweenCheckpoints: unavailable("git-checkpoint.restoreBetweenCheckpoints"),
			deleteCheckpoint: unavailable("git-checkpoint.deleteCheckpoint"),
		} satisfies Record<keyof IGitCheckpointService, WebGuiMethod>),
		createWebGuiService(ServiceChannels.System, {
			info: (): SystemInfo => ({ homedir: os.homedir(), platform: process.platform }),
			// TODO(omp-system): Connect native shell discovery and network probes.
			listIntegratedTerminalShells: unavailable("system.listIntegratedTerminalShells"),
			probeIntranet: unavailable("system.probeIntranet"),
		} satisfies Record<keyof ISystemService, WebGuiMethod>),
		// TODO(omp-file-watcher): Connect native watch/unwatch/disposeAll and the
		// onDynamicChange publisher. Subscription disposal is protocol-only, never
		// a claim that fs.watch was installed or a native watcher id was allocated.
		createWebGuiService(ServiceChannels.FileWatcher, {
			watch: unavailable("file-watcher.watch"),
			unwatch: unavailable("file-watcher.unwatch"),
			disposeAll: unavailable("file-watcher.disposeAll"),
		} satisfies Record<Exclude<keyof IFileWatcherService, "onDynamicChange">, WebGuiMethod>),
		// TODO(omp-attachments): Connect native attachment staging/adoption/cancel/
		// cleanup and onDynamicProgress publishing. Idle event subscriptions are
		// connection-owned; no transfer, file ref or upload result is fabricated.
		createWebGuiService(ServiceChannels.PromptAttachmentTransfer, {
			stage: unavailable("prompt-attachment-transfer.stage"),
			adopt: unavailable("prompt-attachment-transfer.adopt"),
			cancel: unavailable("prompt-attachment-transfer.cancel"),
			cleanup: unavailable("prompt-attachment-transfer.cleanup"),
		} satisfies Record<Exclude<keyof IPromptAttachmentTransferService, "onDynamicProgress">, WebGuiMethod>),
	];
}
