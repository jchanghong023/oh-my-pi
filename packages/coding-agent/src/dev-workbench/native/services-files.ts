import * as os from "node:os";
import type { IFileService } from "../../../../../packages/dev-frontend/packages/services/src/file/file";
import type { IFileWatcherService } from "../../../../../packages/dev-frontend/packages/services/src/fileWatcher/fileWatcher";
import type { IGitService } from "../../../../../packages/dev-frontend/packages/services/src/git/git";
import type { IGitCheckpointService } from "../../../../../packages/dev-frontend/packages/services/src/git/gitCheckpoint";
import type { IMediaPreviewService } from "../../../../../packages/dev-frontend/packages/services/src/media-preview/mediaPreview";
import type { IPromptAttachmentTransferService } from "../../../../../packages/dev-frontend/packages/services/src/prompt-attachment-transfer/promptAttachmentTransfer";
import type { ISystemService } from "../../../../../packages/dev-frontend/packages/services/src/system/system";
import { ServiceChannels } from "../../../../../packages/dev-frontend/packages/shared/src/channels";
import type {
	GitRefreshResult,
	GitRepositorySummary,
	GitWorkspaceRepositoryInfo,
} from "../../../../../packages/dev-frontend/packages/shared/src/git";
import type { SystemInfo } from "../../../../../packages/dev-frontend/packages/shared/src/protocol";
import { createNativeAttachmentMethods } from "./native-attachments";
import { createNativeFileMethods, createNativeFileWatcherMethods } from "./native-files";
import { createNativeGitMethods } from "./native-git";
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
	const watchers = createNativeFileWatcherMethods(context);
	const attachments = createNativeAttachmentMethods(context);
	// Unbound attachments retain unavailable reads without scanning any native workspace.
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
			// Workspace creation, unsupported previews and ignore-file edits remain unavailable.
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
			...createNativeFileMethods(context),
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
			// Unsupported reads and all Git mutations remain unavailable.
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
			...(context.projectId ? createNativeGitMethods(context) : {}),
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
			// TODO(omp-system): Connect native network probes.
			probeIntranet: unavailable("system.probeIntranet"),
		} satisfies Record<keyof ISystemService, WebGuiMethod>),
		createWebGuiService(
			ServiceChannels.FileWatcher,
			{
				watch: watchers.methods.watch,
				unwatch: watchers.methods.unwatch,
				disposeAll: watchers.methods.disposeAll,
			} satisfies Record<Exclude<keyof IFileWatcherService, "onDynamicChange">, WebGuiMethod>,
			{
				dynamicEvents: watchers.dynamicEvents,
				dispose: watchers.dispose,
			},
		),
		createWebGuiService(
			ServiceChannels.PromptAttachmentTransfer,
			{
				stage: attachments.methods.stage,
				adopt: attachments.methods.adopt,
				cancel: attachments.methods.cancel,
				cleanup: attachments.methods.cleanup,
			} satisfies Record<Exclude<keyof IPromptAttachmentTransferService, "onDynamicProgress">, WebGuiMethod>,
			{
				dynamicEvents: attachments.dynamicEvents,
				dispose: attachments.dispose,
			},
		),
	];
}
