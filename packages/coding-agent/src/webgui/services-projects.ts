import type { HighspeedServiceSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/highspeed";
import type {
	OffPeakCodingPlanSupport,
	OffPeakTakeNumberAvailability,
	ZCodeOffPeakTask,
} from "../../../../vendor/zcode-frontend/packages/shared/src/off-peak-types";
import type {
	ProjectTree,
	VirtualProject,
} from "../../../../vendor/zcode-frontend/packages/services/src/project-storage/repository-contract";
import type { TaskGroupStructure } from "../../../../vendor/zcode-frontend/packages/services/src/task-groups/contract";
import type { WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import { createWebGuiService } from "./service-channel";

/**
 * These reads describe only this browser attachment's empty resource view, not
 * native OMP storage. In particular, an OMP workspace binding is not a ZCode
 * database project, task, host identity, or persistent history record.
 */
export function createProjectServices(_context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	return [
		// TODO(omp-project): Integrate the native OMP project registry and SessionManager
		// reads. Directory access, project mutations, session preparation/resolution,
		// and data measurement/deletion remain explicitly unavailable by default.
		createWebGuiService("project", {
			readProjects: (): VirtualProject[] => [],
			readTree: (): ProjectTree => ({ projects: [], tasks: [], deletedTasks: [] }),
		}),
		// TODO(omp-project-task-groups): Integrate OMP project/task organization storage.
		// Reading never admits tasks; save, ungroup, move and admit must reject until then.
		createWebGuiService("task-groups", {
			read: (): TaskGroupStructure => ({ groups: [], members: [], order: [] }),
		}),
		// TODO(omp-scheduler): Integrate native OMP scheduler persistence and provider
		// admission. Empty attachment reads do not inspect persisted scheduled jobs;
		// create/cancel/pause/continue/delete/deleteHistory/update remain unavailable.
		createWebGuiService("off-peak-task", {
			getCodingPlanSupport: (): OffPeakCodingPlanSupport => ({
				supported: false,
				reason: "connection_unavailable",
			}),
			getTakeNumberAvailability: (): OffPeakTakeNumberAvailability => ({ canTakeNumber: false }),
			list: (): ZCodeOffPeakTask[] => [],
			get: (): ZCodeOffPeakTask | null => null,
		}),
		// TODO(omp-session-manager-highspeed): Integrate native OMP provider/billing
		// admission. This attachment owns no card or draw; prepareTurn, invalidateCard
		// and healthy remain unavailable rather than pretending a subscription exists.
		createWebGuiService("highspeed-card", {
			getSnapshot: (): HighspeedServiceSnapshot => ({ card: null, nextDrawAt: null, drawing: false }),
		}),
		// TODO(omp-session-manager-bots): Integrate native OMP SessionManager/project
		// channel delivery and configuration. Bot status has no unavailable variant;
		// status/config reads, runtime preference sync, registrations, bot management,
		// topic/group operations and message/callback dispatch all explicitly reject.
		createWebGuiService("bots", {}),
	];
}
