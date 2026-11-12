import { getEmployeeId } from "../identity.js";
export function prototypeProjectDirectories() {
 const employeeId = getEmployeeId();
 return [
	{ path: `/demo/${employeeId}/aurora-console`, name: "我的 Aurora 开发项目", git: true, branch: "main", repositoryRoot: "/demo/aurora-console" },
	{ path: `/demo/${employeeId}/mobile-console`, name: "我的 Mobile 开发项目", git: true, branch: "main", repositoryRoot: "/demo/mobile-console" },
	{ path: "/demo/shared/aurora-console", name: "Aurora 共享读取副本", git: true, branch: "main", repositoryRoot: "/demo/aurora-console" },
  { path: "/demo/shared/mobile-console", name: "Mobile 共享读取副本", git: true, branch: "main", repositoryRoot: "/demo/mobile-console" },
	{ path: "/demo/aurora-console", name: "Aurora 协作控制台", git: true, branch: "main" },
	{ path: "/demo/mobile-console", name: "Mobile 移动工作台", git: true, branch: "main" },
	{ path: "/demo/payment-service", name: "Payment 支付服务", git: true, branch: "main" },
	{ path: "/demo/design-system", name: "Design 组件库", git: true, branch: "develop" },
	{ path: "/demo/notes", name: "notes", git: false, branch: "" },
	{ path: "/demo/downloads", name: "downloads", git: false, branch: "" },
];
}

export function normalizePrototypeProjectPath(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** 只验证演示目录清单，绝不把样例检查解释为真实文件系统事实。 */
export function checkPrototypeProjectDirectory(path: string, existingRoots: string[]) {
	const root = normalizePrototypeProjectPath(path);
	if (!root) return { valid: false as const, error: "请先选择或输入项目目录。" };
	if (existingRoots.some(existing => normalizePrototypeProjectPath(existing) === root)) {
		return { valid: false as const, error: "该项目目录已添加，无需重复添加。" };
	}
	const directory = prototypeProjectDirectories().find(item => item.path === root);
	if (!directory) return { valid: false as const, error: "未找到此演示目录。请从“浏览目录”选择样例；真实路径校验尚未接入。" };
	if (!directory.git) return { valid: false as const, error: "此目录不是 Git 项目，未找到有效的 Git 仓库。请选择已有 Git 项目的根目录。" };
	return { valid: true as const, root, directory };
}

export function checkPrototypeDevelopmentDirectory(path: string, sharedRoot: string) {
	const check = checkPrototypeProjectDirectory(path, []);
	if (!check.valid) return check;
	if (check.root === sharedRoot) return { valid: false as const, error: "共享项目路径只读，请选择自己的开发项目目录。" };
	if (prototypeRepositoryRoot(check.root) !== prototypeRepositoryRoot(sharedRoot)) return { valid: false as const, error: "该目录与所选共享项目不是同一仓库，请选择对应的开发项目。" };
	return check;
}

export function prototypeRepositoryRoot(path: string): string {
  const normalized = normalizePrototypeProjectPath(path);
  const directory = prototypeProjectDirectories().find(item => item.path === normalized);
  return directory?.repositoryRoot ?? normalized;
}
