/**
 * 从 coverage.py 生成的 coverage.json 中提取指定文件的覆盖率信息，
 * 从 pytest -v 输出中提取测试执行结果，
 * 生成 .codecovcli/cache 格式的 JSON 文件。
 *
 * 用法: node extract-python-coverage.js <类名/模块名> <coverage.json路径> [pytest-v输出路径]
 * 示例: node extract-python-coverage.js user_service coverage.json
 *       node extract-python-coverage.js user_service coverage.json pytest-output.txt
 *
 * 如果不指定 pytest-v 输出路径，测试执行结果相关字段将填 0。
 *
 * 输出: <cwd>/.codecovcli/cache/python_<类名>.json
 */

const fs = require('fs');
const path = require('path');

// ========== 参数解析 ==========
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('用法: node extract-python-coverage.js <类名/模块名> <coverage.json路径> [pytest-v输出路径]');
  console.error('示例: node extract-python-coverage.js user_service coverage.json');
  console.error('示例: node extract-python-coverage.js user_service coverage.json pytest-output.txt');
  process.exit(1);
}

const className = args[0];
const coverageJsonPath = path.resolve(args[1]);
const pytestVPath = args[2] ? path.resolve(args[2]) : null;

// ========== 兜底变量 ==========
// 当 coverage.json 不存在或解析失败时，使用 0 覆盖率数据写入 JSON，
// 确保 DTAgent-Plugin 能上报测试执行结果（含编译失败场景）。
let errorDetail = '';
let totalLines = 0;
let coveredLines = 0;
let missedLines = 0;
let linePercentage = 0;
let coveredLineNumbers = [];
let missedLineNumbers = [];
let targetFilePath = '';

// ========== 读取 coverage.json 文件 ==========
let coverageData = null;
if (!fs.existsSync(coverageJsonPath)) {
  errorDetail = `coverage.json 文件不存在: ${coverageJsonPath}`;
  console.error(`[ERROR] ${errorDetail}`);
} else {
  try {
    const coverageContent = fs.readFileSync(coverageJsonPath, 'utf-8');
    coverageData = JSON.parse(coverageContent);
  } catch (err) {
    errorDetail = `解析 coverage.json 失败: ${err.message}`;
    console.error(`[ERROR] ${errorDetail}`);
  }
}

// ========== 解析 coverage.json ==========
// coverage.py JSON 格式:
//   "files": {
//     "path/to/module.py": {
//       "executed_lines": [1, 2, 3],
//       "missing_lines": [4, 5],
//       "summary": {
//         "covered_lines": 3,
//         "missing_lines": 2,
//         "num_statements": 5,
//         "percent_covered": 60.0
//       }
//     }
//   },
//   "totals": { ... }
let targetFileData = null;

if (coverageData) {
  const targetFileSuffix = '/' + className + '.py';
  const files = coverageData.files || {};

  // 在 files 中查找路径以 /{className}.py 结尾的条目
  for (const [filePath, fileData] of Object.entries(files)) {
    // 统一路径分隔符后匹配
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (normalizedPath.endsWith(targetFileSuffix)) {
      targetFileData = fileData;
      targetFilePath = filePath;
      break;
    }
  }

  if (!targetFileData) {
    errorDetail = errorDetail || `未在 coverage.json 中找到目标文件: ${className}.py`;
    console.error(`[ERROR] ${errorDetail}`);
    console.error(`请在 coverage.json 的 files 中确认文件路径以 /${className}.py 结尾`);
  } else {
    const summary = targetFileData.summary || {};
    totalLines = summary.num_statements || 0;
    coveredLines = summary.covered_lines || 0;
    missedLines = summary.missing_lines || 0;
    linePercentage = totalLines > 0
      ? Math.round((coveredLines / totalLines) * 10000) / 100
      : 0;

    // 收集行级覆盖详情
    coveredLineNumbers = (targetFileData.executed_lines || []).slice().sort((a, b) => a - b);
    missedLineNumbers = (targetFileData.missing_lines || []).slice().sort((a, b) => a - b);

    // ========== 覆盖率数据校验 ==========
    const validation = validateCoverageData(totalLines, coveredLines);
    if (!validation.valid) {
      errorDetail = errorDetail || `覆盖率数据校验失败: ${validation.reason}`;
      console.error(`\n[ERROR] ${errorDetail}`);
      console.error(`被测文件: ${className}.py`);
      console.error(`总行数: ${totalLines}, 覆盖行数: ${coveredLines}`);
    }
  }
}

// ========== 从 pytest -v 输出中提取测试执行结果 ==========
// pytest -v 输出格式:
//   test_file.py::test_function PASSED [ 50%]
//   test_file.py::test_function FAILED [100%]
//   test_file.py::test_function ERROR [ 33%]
// 编译/收集错误时:
//   ERROR collecting test_file.py
//   ...
//   ===== short test summary info =====
//   ERROR test_file.py
// 最后一行汇总: X failed, Y passed in Zs
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let compileErrors = 0;
let testName = '';

if (pytestVPath && fs.existsSync(pytestVPath)) {
  const testOutput = fs.readFileSync(pytestVPath, 'utf-8');
  const testLines = testOutput.split('\n');

  // 检测收集错误（编译错误等价物）
  // ERROR collecting 表示测试收集阶段出错
  const hasCollectionError = /ERROR collecting/i.test(testOutput);
  // ===== short test summary info ===== 后面跟着 ERROR 行
  const hasSummaryError = /===== short test summary info =====[\s\S]*?ERROR /i.test(testOutput);
  if (hasCollectionError || hasSummaryError) {
    compileErrors = 1;
  }

  // 统计 PASSED、FAILED、ERROR 数量
  // pytest -v 每个测试用例一行：test_file.py::test_name RESULT [ progress%]
  for (const line of testLines) {
    const trimmed = line.trim();

    // 匹配 pytest -v 结果行：文件路径::测试名 PASSED/FAILED/ERROR [百分比]
    // 格式: <path>::<test_id> PASSED [ 50%]
    const resultMatch = /^(.+\.py)::(.+?)\s+(PASSED|FAILED|ERROR)\s*\[/.exec(trimmed);
    if (resultMatch) {
      const result = resultMatch[3];
      totalTests++;
      if (!testName) {
        testName = resultMatch[2];
      }
      if (result === 'PASSED') {
        passedTests++;
      } else if (result === 'FAILED') {
        failedTests++;
      }
      // ERROR 状态的用例不计入 passedTests 也不计入 failedTests，但已计入 totalTests
    }
  }

  // 如果没有检测到测试结果行，尝试从汇总行解析
  if (totalTests === 0) {
    // 汇总行格式: N failed, M passed in Xs 或 N passed in Xs 等
    const summaryMatch = /(\d+)\s+failed(?:.*?(\d+)\s+passed)?/i.exec(testOutput);
    const passedOnlyMatch = /(\d+)\s+passed/i.exec(testOutput);

    if (summaryMatch) {
      failedTests = parseInt(summaryMatch[1]) || 0;
      passedTests = summaryMatch[2] ? parseInt(summaryMatch[2]) : 0;
      totalTests = passedTests + failedTests;
      if (failedTests > 0 && !testName) {
        testName = 'pytest_failed';
      }
    } else if (passedOnlyMatch) {
      passedTests = parseInt(passedOnlyMatch[1]);
      totalTests = passedTests;
    }
  }

  // 如果有收集错误且没有解析到测试结果，设置默认测试名
  if (!testName && compileErrors) {
    testName = 'pytest_collection_error';
  }
}

// ========== 查找并读取测试文件代码行数 ==========
// Python 测试文件通常命名为 test_{className}.py 或 {className}_test.py
let testFileLines = 0;
let testFilePath = null;

// 优先查找 test_{className}.py
testFilePath = findTestFile(`test_${className}.py`, process.cwd(), 5);

// 如果没找到，尝试 {className}_test.py
if (!testFilePath) {
  testFilePath = findTestFile(`${className}_test.py`, process.cwd(), 5);
}

if (testFilePath) {
  const testContent = fs.readFileSync(testFilePath, 'utf-8');
  testFileLines = countCodeLines(testContent);
}

// ========== 控制台输出 ==========
console.log('');
console.log('============================================================');
console.log('  Python 代码覆盖率报告');
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
console.log(`被测文件：${targetFilePath}`);
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
    language: 'python',
    projectDir: process.cwd(),
    version: '1.0.0',
  },
  errorDetail: errorDetail,
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

const outputPath = path.join(outputDir, `python_${className}.json`);
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
console.log(`覆盖率文件已生成: ${outputPath}`);

// ========== 辅助函数 ==========

/**
 * 覆盖率数据校验
 * 防御性检查：总数为0或负数、覆盖行大于总行数、异常低覆盖率
 * @param {number} total - 总行数
 * @param {number} covered - 已覆盖行数
 * @returns {{valid: boolean, reason?: string}}
 */
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

/**
 * 递归查找测试文件
 * @param {string} fileName - 测试文件名（如 test_user_service.py）
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
      // 跳过无关目录
      if (['venv', '.venv', '.git', 'node_modules', '.codecovcli', '__pycache__', '.pytest_cache', 'env'].includes(entry.name)) {
        continue;
      }
      const found = findTestFile(fileName, path.join(dir, entry.name), maxDepth - 1);
      if (found) return found;
    }
  }

  return null;
}

/**
 * 统计 Python 测试文件的实际代码行数
 * 排除：空行、注释（# 单行注释）、docstring（"""或'''包裹的块）、import 语句、from ... import 语句
 * @param {string} content - 文件内容
 * @returns {number} 实际代码行数
 */
function countCodeLines(content) {
  const lines = content.split('\n');
  let codeLines = 0;
  let inDocstring = false;
  let docstringDelimiter = null; // '"""' 或 "'''"

  for (const line of lines) {
    const trimmed = line.trim();

    // 跳过空行
    if (trimmed === '') {
      continue;
    }

    // 处理 docstring 内部
    if (inDocstring) {
      // 检查当前行是否包含结束的 delimiter
      if (trimmed.includes(docstringDelimiter)) {
        inDocstring = false;
        docstringDelimiter = null;
        // 如果 delimiter 后面还有代码，也不额外处理（Python 习惯上 docstring 结束后不跟代码）
      }
      continue;
    }

    // 检查是否开始 docstring（单行或多行）
    // 三引号 """ 或 '''
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      const delimiter = trimmed.slice(0, 3);
      // 单行 docstring："""xxx""" 在同一行结束
      const rest = trimmed.slice(3);
      if (rest.includes(delimiter)) {
        // 单行 docstring，跳过此行
        continue;
      } else {
        // 多行 docstring 开始
        inDocstring = true;
        docstringDelimiter = delimiter;
        continue;
      }
    }

    // 跳过单行注释
    if (trimmed.startsWith('#')) {
      continue;
    }

    // 跳过 import 语句
    if (trimmed.startsWith('import ') || trimmed === 'import') {
      continue;
    }

    // 跳过 from ... import 语句
    if (trimmed.startsWith('from ') && trimmed.includes(' import')) {
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
