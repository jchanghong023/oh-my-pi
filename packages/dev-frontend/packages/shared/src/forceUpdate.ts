interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(version: string): ParsedSemver | null {
  const normalized = version.trim().replace(/^v/i, "");

  // 兼容省略次版本号或补丁版本号的简写格式。
  const strictMatch = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (strictMatch) {
    return {
      major: Number(strictMatch[1]!),
      minor: Number(strictMatch[2]!),
      patch: Number(strictMatch[3]!),
      prerelease: strictMatch[4]?.split(".") ?? [],
    };
  }

  // 补全：只有主版本号（"45" → "45.0.0"）
  const majorOnly = normalized.match(/^(\d+)$/);
  if (majorOnly) {
    return {
      major: Number(majorOnly[1]!),
      minor: 0,
      patch: 0,
      prerelease: [],
    };
  }

  // 补全：主版本号.次版本号（"4.5" → "4.5.0"）
  const majorMinor = normalized.match(/^(\d+)\.(\d+)$/);
  if (majorMinor) {
    return {
      major: Number(majorMinor[1]!),
      minor: Number(majorMinor[2]!),
      patch: 0,
      prerelease: [],
    };
  }

  return null;
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const delta = Number(leftPart) - Number(rightPart);
      if (delta !== 0) {
        return delta > 0 ? 1 : -1;
      }
      continue;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }

    const delta = leftPart.localeCompare(rightPart);
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }

  return 0;
}

export function compareSemverVersions(leftVersion: string, rightVersion: string): number | null {
  const left = parseSemver(leftVersion);
  const right = parseSemver(rightVersion);
  if (!left || !right) {
    return null;
  }

  for (const key of ["major", "minor", "patch"] as const) {
    const delta = left[key] - right[key];
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }

  return comparePrerelease(left.prerelease, right.prerelease);
}
