import { RepoService } from "../../src/repo/service";

const service = new RepoService({ cwd: process.argv[2]!, agentDir: process.argv[3]! });
const options = {
	onProgress(progress: { phase: string; processed: number }) {
		if (progress.phase !== "reading" || progress.processed !== 1) return;
		process.stdout.write("STAGED\n");
		// Parent kills this process after a committed staged file, bypassing finally.
		Bun.sleepSync(60_000);
	},
};
if (service.storage.state().generation) await service.rebuild(options);
else await service.build(options);
