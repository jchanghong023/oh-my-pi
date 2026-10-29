import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const python = process.platform === "win32" ? "python" : "python3";
const runner = path.join(import.meta.dir, "test-report-py.ts");
let available = false;
try {
	available =
		Bun.spawnSync([python, "-c", "import pytest, testmon"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
} catch {
	// Optional for the Bun script suite; Python dependencies may not be installed.
}
if (!available) console.warn("Skipping Python runner behavior tests: Python, pytest or pytest-testmon unavailable");
const roots: string[] = [];
afterAll(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "python-runner-"));
	roots.push(root);
	for (const project of ["sdk/python/omp-rpc", "python/robomp"]) {
		const dir = path.join(root, project, "tests");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "source_a.py"), "def marker():\n    return 'a'\n");
		fs.writeFileSync(path.join(dir, "source_b.py"), "def marker():\n    return 'b'\n");
		fs.writeFileSync(
			path.join(dir, "test_cases.py"),
			`import os\nimport source_a\nimport source_b\n\ndef record(name):\n    with open(os.environ['CASE_LOG'], 'a') as f:\n        f.write('${project}:' + name + '\\n')\n\ndef test_a():\n    record(source_a.marker())\n\ndef test_b():\n    record(source_b.marker())\n`,
		);
	}
	const smoke = path.join(root, "python/robomp/tests/test_worker_smoke.py");
	fs.writeFileSync(
		smoke,
		"import os\nimport pytest\n\n@pytest.mark.skipif(os.getenv('ROBOMP_INTEGRATION') != '1', reason='integration')\ndef test_smoke():\n    with open(os.environ['CASE_LOG'], 'a') as f:\n        f.write('integration\\n')\n",
	);
	return root;
}

function run(root: string, args: string[] = [], ci?: string) {
	const log = path.join(root, "cases.log");
	fs.writeFileSync(log, "");
	const reportDir = path.join(root, "reports");
	fs.rmSync(reportDir, { recursive: true, force: true });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CASE_LOG: log,
		ROBOMP_INTEGRATION: "1",
		OMP_TEST_REPORT_DIR: reportDir,
	};
	if (ci === undefined) delete env.CI;
	else env.CI = ci;
	const result = Bun.spawnSync([process.execPath, runner, ...args], {
		cwd: root,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const reports = fs.existsSync(reportDir)
		? fs
				.readdirSync(reportDir)
				.filter(name => name.endsWith(".producer.json"))
				.map(name => JSON.parse(fs.readFileSync(path.join(reportDir, name), "utf8")))
		: [];
	return { result, cases: fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).sort(), reports };
}

const windows = process.platform === "win32";
const sdkCases = ["sdk/python/omp-rpc:a", "sdk/python/omp-rpc:b"];
const allCases = windows ? sdkCases : ["python/robomp:a", "python/robomp:b", ...sdkCases].sort();

test.skipIf(!available)(
	"ordinary runs select changed cases and preserve independent integration scope",
	() => {
		const root = fixture();
		const first = run(root);
		expect(first.result.exitCode).toBe(0);
		expect(first.cases).toEqual(allCases);
		const second = run(root, [], "true");
		expect(second.result.exitCode).toBe(0);
		expect(second.cases).toEqual([]);
		for (const invocation of [first, second]) {
			expect(invocation.reports.map(report => report.report)).toEqual(
				windows ? ["available"] : ["available", "available"],
			);
			expect(invocation.reports.every(report => report.selection?.tool === "pytest-testmon")).toBe(true);
			if (windows) {
				expect(invocation.result.stdout.toString()).toContain(
					"SKIPPED: Robomp tests are unsupported on native Windows.",
				);
			}
		}
		expect(first.reports.every(report => report.selection.selected > 0 && report.selection.deselected === 0)).toBe(
			true,
		);
		expect(
			second.reports.every(
				report =>
					report.status === "not-selected" && report.selection.selected === 0 && report.selection.deselected > 0,
			),
		).toBe(true);
		const sdkSourceA = path.join(root, "sdk/python/omp-rpc/tests/source_a.py");
		fs.writeFileSync(sdkSourceA, "def marker():\n    return 'a-changed'\n");
		const changed = run(root);
		expect(changed.result.exitCode).toBe(0);
		expect(changed.cases).toEqual(["sdk/python/omp-rpc:a-changed"]);
		const execution = run(root, ["integration"]);
		if (windows) {
			expect(execution.result.exitCode).not.toBe(0);
			expect(execution.result.stderr.toString()).toContain(
				"UNSUPPORTED: Robomp integration tests are unsupported on native Windows.",
			);
			expect(execution.cases).toEqual([]);
			expect(execution.reports).toEqual([]);
		} else {
			expect(execution.result.exitCode).toBe(0);
			expect(execution.cases).toEqual(["integration"]);
		}
	},
	120_000,
);

test.skipIf(!available)(
	"continues after collection errors and test failures, preserving the first exit code",
	() => {
		const root = fixture();
		const sdk = path.join(root, "sdk/python/omp-rpc/tests/test_cases.py");
		const robomp = path.join(root, "python/robomp/tests/test_cases.py");
		fs.writeFileSync(sdk, "def broken(:\n");
		fs.writeFileSync(
			robomp,
			"import os\n\ndef test_failure():\n    assert False\n\ndef test_after_failure():\n    with open(os.environ['CASE_LOG'], 'a') as f:\n        f.write('after failure\\n')\n",
		);
		const collection = run(root);
		expect(collection.result.exitCode).toBe(2);
		expect(collection.cases).toEqual(windows ? [] : ["after failure"]);
		expect(collection.reports.map(report => report.exitCode).sort()).toEqual(windows ? [2] : [1, 2]);
		expect(collection.reports.every(report => report.report === "available")).toBe(true);
		fs.writeFileSync(
			sdk,
			"import os\n\ndef test_failure():\n    assert False\n\ndef test_after_failure():\n    with open(os.environ['CASE_LOG'], 'a') as f:\n        f.write('sdk after failure\\n')\n",
		);
		const failure = run(root);
		expect(failure.result.exitCode).toBe(1);
		expect(failure.cases).toEqual(windows ? ["sdk after failure"] : ["after failure", "sdk after failure"]);
		expect(failure.reports).toHaveLength(windows ? 1 : 2);
		expect(run(root, ["--full"]).result.exitCode).not.toBe(0);
		expect(run(root, ["--unknown"]).result.exitCode).not.toBe(0);
	},
	120_000,
);
