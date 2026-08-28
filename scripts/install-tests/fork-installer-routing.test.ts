import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "../..");
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

async function createFixture(): Promise<{ env: NodeJS.ProcessEnv; log: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fork-installer-"));
	tempDirs.push(dir);
	const binDir = path.join(dir, "bin");
	const installDir = path.join(dir, "install");
	const log = path.join(dir, "commands.log");
	await fs.mkdir(binDir);
	await Bun.write(log, "");

	await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
	await writeExecutable(binDir, "ldd", "#!/bin/sh\necho 'ldd (GNU libc) 2.39'\n");
	await writeExecutable(
		binDir,
		"curl",
		`#!/bin/sh
printf 'curl %s\\n' "$*" >> "$TEST_LOG"
case "$*" in
  *api.github.com*)
    case "$*" in
      */releases/tags/*) tag="\${*##*/releases/tags/}" ;;
      *) tag="v18.0.9+fork.125" ;;
    esac
    printf '{"tag_name":"%s"}\\n' "$tag"
    ;;
  *)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "-o" ]; then
        printf '%s\\n' '#!/bin/sh' 'echo "omp test"' > "$2"
        exit 0
      fi
      shift
    done
    exit 1
    ;;
esac
`,
	);
	await writeExecutable(
		binDir,
		"bun",
		`#!/bin/sh
printf 'bun %s\\n' "$*" >> "$TEST_LOG"
case "$1" in
  --version) echo 1.3.14 ;;
  -e) printf x64 ;;
  install) exit 0 ;;
  *) exit 1 ;;
esac
`,
	);
	await writeExecutable(
		binDir,
		"git",
		`#!/bin/sh
printf 'git %s\\n' "$*" >> "$TEST_LOG"
if [ "$1" = "clone" ]; then
  for destination do :; done
  mkdir -p "$destination/packages/coding-agent"
fi
`,
	);

	return {
		log,
		env: {
			...process.env,
			PATH: `${binDir}:/usr/bin:/bin`,
			HOME: dir,
			PI_INSTALL_DIR: installDir,
			TEST_LOG: log,
		},
	};
}

async function runInstaller(args: string[]): Promise<{ exitCode: number; stdout: string; commands: string }> {
	const fixture = await createFixture();
	const proc = Bun.spawn(["sh", "scripts/install.sh", ...args], {
		cwd: repoRoot,
		env: fixture.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const commands = await Bun.file(fixture.log).text();
	if (stderr) throw new Error(stderr);
	return { exitCode, stdout, commands };
}

describe("fork installer routing", () => {
	test("defaults to the latest fork release even when Bun is available", async () => {
		const result = await runInstaller([]);
		expect(result.exitCode, result.stdout).toBe(0);
		expect(result.commands).toContain("api.github.com/repos/jchanghong023/oh-my-pi/releases/latest");
		expect(result.commands).toContain(
			"github.com/jchanghong023/oh-my-pi/releases/download/v18.0.9+fork.125/omp-linux-x64",
		);
		expect(result.commands).not.toContain("bun install");
	});

	test("source mode clones fork main and installs its local package", async () => {
		const result = await runInstaller(["--source"]);
		expect(result.exitCode, result.stdout).toBe(0);
		expect(result.commands).toContain(
			"git clone --depth 1 --branch main https://github.com/jchanghong023/oh-my-pi.git",
		);
		expect(result.commands).toMatch(/bun install -g \/tmp\/tmp\.[^/]+\/packages\/coding-agent/);
		expect(result.commands).not.toContain("api.github.com");
	});

	test("a ref without source mode selects that fork release", async () => {
		const result = await runInstaller(["--ref", "v18.0.9+fork.125"]);
		expect(result.exitCode, result.stdout).toBe(0);
		expect(result.commands).toContain("api.github.com/repos/jchanghong023/oh-my-pi/releases/tags/v18.0.9+fork.125");
		expect(result.commands).not.toContain("git clone");
		expect(result.commands).not.toContain("bun install");
	});
});
