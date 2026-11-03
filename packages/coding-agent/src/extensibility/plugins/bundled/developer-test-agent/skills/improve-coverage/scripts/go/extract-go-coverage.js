/**
 * 从 go test -coverprofile 输出中提取指定文件的覆盖率信息，
 * 从 go test -v 输出中提取测试执行结果，
 * 生成 .codecovcli/cache 格式的 JSON 文件。
 *
 * 用法: node extract-go-coverage.js <类名/模块名> <coverprofile路径> [go-test-v输出路径]
 * 示例: node extract-go-coverage.js string_utils coverage.out
 *       node extract-go-coverage.js string_utils coverage.out go-test-output.txt
 *
 * 如果不指定 go-test-v 输出路径，测试执行结果相关字段将填 0。
 *
 * 输出: <cwd>/.codecovcli/cache/go_<类名>.json
 *
 * 异常处理：当 coverprofile 文件不存在、目标文件未找到或数据校验失败时，
 * 脚本仍会写入 JSON 文件（含 errorDetail 字段和 0 覆盖率数据），
 * 确保 DTAgent-Plugin 能上报测试执行结果（含编译失败等场景）。
 */

const fs = require('fs');
const path = require('path');

// ========== 参数解析 ==========
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('用法: node extract-go-coverage.js <类名/模块名> <coverprofile路径> [go-test-v输出路径]');
  console.error('示例: node extract-go-coverage.js string_utils coverage.out');
  console.error('示例: node extract-go-coverage.js string_utils coverage.out go-test-output.txt');
  process.exit(1);
}

const className = args[0];
const coverprofilePath = path.resolve(args[1]);
const goTestVPath = args[2] ? path.resolve(args[2]) : null;

// ========== 从 go test -v 输出中提取测试执行结果 ==========
// go test -v 输出格式:
//   --- PASS: TestXxx (0.00s)    表示通过
//   --- FAIL: TestXxx (0.00s)    表示失败
// 编译失败时:
//   # package/path
//   ./file.go:10:2: undefined: something
//   FAIL    package/path [build failed]
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let compileErrors = 0;
let testName = '';

if (goTestVPath && fs.existsSync(goTestVPath)) {
  const testOutput = fs.readFileSync(goTestVPath, 'utf-8');
  const testLines = testOutput.split('\n');

  // 检测编译错误
  const hasBuildFailed = /\[build failed\]/.test(testOutput);
  const hasCompileError = /^#\s+\S+/m.test(testOutput);
  if (hasBuildFailed || hasCompileError) {
    compileErrors = 1;
  }

  // 统计 PASS 和 FAIL 数量
  // 只统计顶层测试用例（不包含缩进的子测试）
  for (const line of testLines) {
    // 顶层测试结果行（不以空格开头）
    const passMatch = /^--- PASS: (\S+)/.exec(line);
    if (passMatch) {
      passedTests++;
      totalTests++;
      if (!testName) {
        testName = passMatch[1];
      }
    }

    const failMatch = /^--- FAIL: (\S+)/.exec(line);
    if (failMatch) {
      failedTests++;
      totalTests++;
      if (!testName) {
        testName = failMatch[1];
      }
    }
  }

  // 如果没有检测到顶层测试结果，尝试统计子测试（缩进的 --- PASS/FAIL）
  if (totalTests === 0) {
    for (const line of testLines) {
      const passMatch = /^\s+--- PASS: (\S+)/.exec(line);
      if (passMatch) {
        passedTests++;
        totalTests++;
        if (!testName) {
          testName = passMatch[1];
        }
      }

      const failMatch = /^\s+--- FAIL: (\S+)/.exec(line);
      if (failMatch) {
        failedTests++;
        totalTests++;
        if (!testName) {
          testName = failMatch[1];
        }
      }
    }
  }

  // 如果有编译错误且没有解析到测试结果，尝试从测试输出中推断测试名
  if (!testName && !compileErrors) {
    // 尝试从 === RUN 行提取测试名
    for (const line of testLines) {
      const runMatch = /^=== RUN\s+(\S+)/.exec(line);
      if (runMatch) {
        testName = runMatch[1];
        break;
      }
    }
  }
}

// ========== 读取 coverprofile 文件 ==========
const errorDetailParts = [];
let coverContent = null;

if (!fs.existsSync(coverprofilePath)) {
  errorDetailParts.push(`coverprofile文件不存在: ${coverprofilePath}`);
} else {
  coverContent = fs.readFileSync(coverprofilePath, 'utf-8');
}

// ========== 解析 coverprofile ==========
// Go coverprofile 格式:
//   第一行: mode: set (或 count / atomic)
//   数据行: package/file.go:lineStart.col,lineEnd.col numStatements count
//   count=0 表示未覆盖，count>0 表示已覆盖
const targetFileSuffix = '/' + className + '.go';

let totalStatements = 0;   // 总语句数（总行数）
let coveredStatements = 0;  // 已覆盖语句数（已覆盖行数）
let foundTargetFile = false;
const uncoveredBlocks = [];
const coveredBlocks = [];

if (coverContent) {
  const lines = coverContent.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('mode:')) {
      continue;
    }

    // 解析数据行: package/file.go:lineStart.col,lineEnd.col numStatements count
    // 格式: <path>:<startLine>.<startCol>,<endLine>.<endCol> <numStatements> <count>
    const match = /^(.+\.go):(\d+)\.\d+,\d+\.\d+\s+(\d+)\s+(\d+)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const filePath = match[1];
    const startLine = parseInt(match[2]);
    const numStatements = parseInt(match[3]);
    const count = parseInt(match[4]);

    // 过滤到目标文件（文件名匹配 className.go）
    if (!filePath.endsWith(targetFileSuffix)) {
      continue;
    }

    foundTargetFile = true;
    totalStatements += numStatements;

    if (count > 0) {
      coveredStatements += numStatements;
      coveredBlocks.push({ startLine, numStatements, count });
    } else {
      uncoveredBlocks.push({ startLine, numStatements, count });
    }
  }

  if (!foundTargetFile) {
    errorDetailParts.push(`未在coverprofile中找到目标文件: ${className}.go`);
  }
} else {
  // coverprofile 不存在时，尝试从 go-test-v 输出推断编译失败
  if (compileErrors > 0) {
    errorDetailParts.push('go test 编译失败，未生成 coverprofile');
  }
}

const totalLines = totalStatements;
const coveredLines = coveredStatements;
const missedLines = totalLines - coveredLines;
const linePercentage = totalLines > 0
  ? Math.round((coveredLines / totalLines) * 10000) / 100
  : 0;

// ========== 覆盖率数据校验 ==========
const validation = validateCoverageData(totalLines, coveredLines);
if (!validation.valid) {
  errorDetailParts.push(`覆盖率数据校验失败: ${validation.reason}`);
}

function validateCoverageData(total, covered) {
  // 防御：总数为 0 或负数，无法计算比率
  if (!total || total <= 0) {
    return { valid: false, reason: `总行数为 ${total}，数据无效` };
  }

  // 防御：覆盖行大于总行数，数据不一致
  if (covered > total) {
    return { valid: false, reason: `覆盖行(${covered})大于总行数(${total})，数据不一致` };
  }

  // 异常判定：总行数>2000 且覆盖率<60%
  if (total > 2000) {
    const rate = covered / total;
    if (rate < 0.6) {
      return {
        valid: false,
        reason: `异常数据：总行数 ${total}，覆盖行 ${covered}，覆盖率 ${(rate * 100).toFixed(2)}%（总行数>2000且覆盖率<60%）`,
      };
    }
  }

  return { valid: true };
}

// ========== 查找并读取测试文件代码行数 ==========
// Go 测试文件通常命名为 {className}_test.go
let testFileLines = 0;
const testFileName = className + '_test.go';
const testFilePath = findTestFile(testFileName, process.cwd(), 5);

if (testFilePath) {
  const testContent = fs.readFileSync(testFilePath, 'utf-8');
  testFileLines = countCodeLines(testContent);
}

// ========== 收集行级覆盖详情 ==========
const coveredLineNumbers = [];
const missedLineNumbers = [];

for (const block of coveredBlocks) {
  // 将语句块展开为行号列表
  for (let i = 0; i < block.numStatements; i++) {
    coveredLineNumbers.push(block.startLine + i);
  }
}

for (const block of uncoveredBlocks) {
  for (let i = 0; i < block.numStatements; i++) {
    missedLineNumbers.push(block.startLine + i);
  }
}

coveredLineNumbers.sort((a, b) => a - b);
missedLineNumbers.sort((a, b) => a - b);

// ========== 控制台输出 ==========
console.log('');
console.log('============================================================');
console.log('  Go 代码覆盖率报告');
console.log('============================================================');
console.log('');
console.log('汇总信息：');
console.log('行覆盖率 (Line Coverage):');
printTable([
  ['已覆盖行数', String(coveredLines)],
  ['未覆盖行数', String(missedLines)],
  ['总行数', String(totalLines)],
  ['覆盖率', `${linePercentage}%`],
]);
console.log('');
console.log(`被测文件：${className}.go`);
if (testName) {
  console.log(`测试用例：${testName}`);
}
console.log(`测试用例数：${totalTests} (通过: ${passedTests}, 失败: ${failedTests}, 编译错误: ${compileErrors})`);
if (testFilePath) {
  console.log(`测试文件：${testFilePath} (${testFileLines} 行代码)`);
}
console.log(`Missed Lines:`);
console.log(`  ${missedLineNumbers.join(', ')}`);
console.log(`Covered Lines:`);
console.log(`  ${coveredLineNumbers.join(', ')}`);
if (errorDetailParts.length > 0) {
  console.log(`注意事项：`);
  for (const part of errorDetailParts) {
    console.log(`  ${part}`);
  }
}

// ========== 构建输出 JSON ==========
const result = {
  className: className,
  testName: testName,
  scenario: 'class-level',
  timestamp: new Date().toISOString(),
  lineCoverage: {
    totalLines: totalLines,
    coveredLines: coveredLines,
    missedLines: missedLines,
    percentage: linePercentage,
  },
  testResult: {
    totalTests: totalTests,
    passedTests: passedTests,
    failedTests: failedTests,
    compileErrors: compileErrors,
  },
  metrics: {
    compiled_testcase_num: Math.max(0, totalTests - compileErrors),
    passed_testcase_num: passedTests,
    covered_line_num: coveredLines,
    total_compile_error_num: compileErrors,
    total_line_num: totalLines,
    accept_testcase_num: passedTests,
    generate_testcase_num: totalTests,
    total_testcase_num: totalTests,
    accept_line_num: testFileLines,
    generate_line_num: testFileLines,
  },
  metadata: {
    language: 'go',
    projectDir: process.cwd(),
    version: '1.0.0',
  },
  errorDetail: errorDetailParts.length > 0 ? errorDetailParts.join('; ') : '',
};

// ========== 清除历史文件并写入 ==========
const outputDir = path.join(process.cwd(), '.codecovcli', 'cache');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
} else {
  const existingFiles = fs.readdirSync(outputDir);
  for (const file of existingFiles) {
    const filePath = path.join(outputDir, file);
    if (fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath);
    }
  }
  if (existingFiles.length > 0) {
    console.log(`已清除 ${existingFiles.length} 个历史缓存文件`);
  }
}

const outputPath = path.join(outputDir, `go_${className}.json`);
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
console.log(`覆盖率文件已生成: ${outputPath}`);

// ========== 辅助函数 ==========

/**
 * 递归查找测试文件
 * @param {string} fileName - 测试文件名（如 string_utils_test.go）
 * @param {string} dir - 搜索起始目录
 * @param {number} maxDepth - 最大递归深度
 * @returns {string|null} 找到的文件完整路径，未找到返回 null
 */
function findTestFile(fileName, dir, maxDepth) {
  if (maxDepth < 0) return null;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  // 先检查当前目录
  for (const entry of entries) {
    if (entry.isFile() && entry.name === fileName) {
      return path.join(dir, fileName);
    }
  }

  // 递归子目录
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // 跳过 vendor、.git、node_modules 等无关目录
      if (['vendor', '.git', 'node_modules', '.codecovcli', 'testdata'].includes(entry.name)) {
        continue;
      }
      const found = findTestFile(fileName, path.join(dir, entry.name), maxDepth - 1);
      if (found) return found;
    }
  }

  return null;
}

/**
 * 统计 Go 源文件的实际代码行数
 * 排除：空行、注释（单行注释和多行注释块）、package 声明、import 块
 * @param {string} content - 文件内容
 * @returns {number} 实际代码行数
 */
function countCodeLines(content) {
  const lines = content.split('\n');
  let codeLines = 0;
  let inBlockComment = false;
  let inImportBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 跳过空行
    if (trimmed === '') {
      continue;
    }

    // 处理多行注释内部
    if (inBlockComment) {
      if (trimmed.includes('*/')) {
        inBlockComment = false;
        // 如果 */ 后面有代码，不额外处理（Go 习惯上 */ 后不跟代码）
      }
      continue;
    }

    // 跳过 package 声明
    if (trimmed.startsWith('package ')) {
      continue;
    }

    // 处理 import 块（单行 import 或 import ( 块）
    if (trimmed.startsWith('import ')) {
      if (trimmed.includes('(')) {
        inImportBlock = true;
      }
      continue;
    }
    if (trimmed === 'import (') {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock) {
      if (trimmed.includes(')')) {
        inImportBlock = false;
      }
      continue;
    }

    // 跳过单行注释
    if (trimmed.startsWith('//')) {
      continue;
    }

    // 开始多行注释
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/') || trimmed.indexOf('*/') === trimmed.length - 2) {
        inBlockComment = true;
      }
      continue;
    }

    codeLines++;
  }

  return codeLines;
}

/**
 * 格式化输出表格
 * @param {Array<[string, string]>} rows - 表格行数据
 */
function printTable(rows) {
  const col1Width = Math.max(...rows.map(r => displayWidth(r[0])));
  const col2Width = Math.max(...rows.map(r => displayWidth(r[1])));

  const border = `┌${'─'.repeat(col1Width + 2)}┬${'─'.repeat(col2Width + 2)}┐`;
  const separator = `├${'─'.repeat(col1Width + 2)}┼${'─'.repeat(col2Width + 2)}┤`;
  const bottom = `└${'─'.repeat(col1Width + 2)}┴${'─'.repeat(col2Width + 2)}┘`;

  console.log(border);
  rows.forEach((row, i) => {
    const c1 = padRight(row[0], col1Width);
    const c2 = padLeft(row[1], col2Width);
    console.log(`│ ${c1} │ ${c2} │`);
    if (i < rows.length - 1) console.log(separator);
  });
  console.log(bottom);
}

/**
 * 计算字符串的显示宽度（中文字符占 2，其他占 1）
 * @param {string} str
 * @returns {number}
 */
function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0xFF00 && code <= 0xFFEF) ||
      (code >= 0x3400 && code <= 0x4DBF)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * 右侧填充空格使字符串达到指定显示宽度
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function padRight(str, width) {
  const dw = displayWidth(str);
  return str + ' '.repeat(Math.max(0, width - dw));
}

/**
 * 左侧填充空格使字符串达到指定显示宽度
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
function padLeft(str, width) {
  const dw = displayWidth(str);
  return ' '.repeat(Math.max(0, width - dw)) + str;
}
