/**
 * 从 coverage.py JSON 和可选的 pytest/unittest -v 日志生成单模块缓存。
 * 用法: node extract-python-coverage.js <源文件.py> <coverage.json> [测试日志]
 * 输出: <cwd>/.codecovcli/cache/python_<源路径指纹>.json
 */

const { createHash, randomUUID } = require('node:crypto');
const fs = require('fs');
const path = require('path');
const { stripVTControlCharacters } = require('node:util');

// ========== 参数解析 ==========
const args = process.argv.slice(2);
if (args.length < 2 || !args[0].endsWith('.py')) {
  console.error('用法: node extract-python-coverage.js <源文件.py> <coverage.json> [测试日志]');
  process.exit(1);
}

const source = args[0].replace(/\\/g, '/');
const className = path.posix.basename(source, '.py');
const sourcePath = fileIdentity(source);
const relativeSource = path.relative(fileIdentity(process.cwd()), sourcePath).split(path.sep).join('/');
const coverageJsonPath = path.resolve(args[1]);
const testLogPath = args[2] ? path.resolve(args[2]) : null;

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

if (coverageData) {
  const matches = Object.entries(coverageData.files || {}).filter(([filePath]) =>
    fileIdentity(filePath) === sourcePath
  );

  if (matches.length !== 1) {
    errorDetail = matches.length === 0
      ? `未在 coverage.json 中找到目标文件: ${source}`
      : `coverage.json 中有重复的目标文件: ${matches.map(([filePath]) => filePath).join(', ')}`;
    console.error(`[ERROR] ${errorDetail}`);
  } else {
    const [[filePath, fileData]] = matches;
    targetFilePath = filePath;
    const summary = fileData.summary || {};
    const total = summary.num_statements || 0;
    const covered = summary.covered_lines || 0;
    const validation = validateCoverageData(total, covered);
    if (!validation.valid) {
      errorDetail = `覆盖率数据校验失败: ${validation.reason}`;
      console.error(`\n[ERROR] ${errorDetail}`);
      console.error(`被测文件: ${targetFilePath}`);
      console.error(`总行数: ${total}, 覆盖行数: ${covered}`);
    } else {
      totalLines = total;
      coveredLines = covered;
      missedLines = summary.missing_lines || 0;
      linePercentage = Math.round((coveredLines / totalLines) * 10000) / 100;
      if (total > 2000 && covered / total < 0.6) {
        console.warn(`[WARN] ${targetFilePath}：总行数 ${total}，覆盖行 ${covered}，覆盖率 ${linePercentage.toFixed(2)}%（总行数>2000且覆盖率<60%）`);
      }
      coveredLineNumbers = (fileData.executed_lines || []).slice().sort((a, b) => a - b);
      missedLineNumbers = (fileData.missing_lines || []).slice().sort((a, b) => a - b);
    }
  }
}

// ========== 从 pytest / unittest -v 输出中提取测试执行结果 ==========
// pytest -v 输出格式:
//   test_file.py::test_function PASSED [ 50%]
//   test_file.py::test_function FAILED [100%]
//   test_file.py::test_function ERROR [ 33%]
// pytest-xdist: [gw0] [100%] PASSED test_file.py::test_function
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let compileErrors = 0;
let testName = '';
let testFilePath;
let testFileLines = 0;

if (testLogPath && fs.existsSync(testLogPath)) {
  const testBytes = fs.readFileSync(testLogPath);
  // Windows PowerShell 5.1 redirects text as UTF-16LE with a BOM.
  const encoding = testBytes[0] === 0xff && testBytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
  const testOutput = new TextDecoder(encoding).decode(testBytes);
  const testResults = new Map();
  const reportedTestFiles = new Set();
  let pendingUnittestId;

  for (const line of testOutput.split('\n')) {
    const trimmed = stripVTControlCharacters(line).trimEnd();
    const result = /^(?<filePath>.+?\.py)::(?<testId>.+?)\s+(?<status>PASSED|FAILED|ERROR)(?:\s+\[\s*\d+%\])?$/.exec(trimmed)
      || /^\[gw\d+\]\s+(?:\[\s*\d+%\]\s+)?(?<status>PASSED|FAILED|ERROR)\s+(?<filePath>.+?\.py)::(?<testId>.+)$/.exec(trimmed);
    if (result) {
      const { filePath, testId, status } = result.groups;
      const nodeId = `${filePath}::${testId}`;
      // A teardown error overrides a successful test body.
      if (status !== 'PASSED' || !testResults.has(nodeId)) {
        testResults.set(nodeId, status);
      }
      reportedTestFiles.add(filePath);
      if (!testName) testName = testId;
      continue;
    }

    const collection = /^_+\s+ERROR collecting (.+?)\s+_+$/.exec(trimmed);
    if (collection) {
      compileErrors++;
      if (collection[1].endsWith('.py')) reportedTestFiles.add(collection[1]);
      continue;
    }

    // unittest on Python 3.6 prints `method (module.Class) ... ok`.
    // A test docstring or subtest can put the outcome on the following line.
    const unit = /^\s*(?<testId>\S+ \([^)]+\))(?: \(.+\))?(?: \.\.\.(?: (?<status>.+))?)?$/.exec(trimmed);
    const testId = unit?.groups.testId ?? pendingUnittestId;
    const status = unit ? unit.groups.status : / \.\.\. (ok|FAIL|ERROR|unexpected success)$/.exec(trimmed)?.[1];
    pendingUnittestId = unit && !status ? testId : undefined;
    if (!testId || !status) continue;
    if (status === 'ERROR' && /^(?:setUp|tearDown)(?:Class|Module) |\(unittest\.loader\._FailedTest[.)]/.test(testId)) {
      compileErrors++;
    } else if (status === 'ok' || status === 'FAIL' || status === 'ERROR' || status === 'unexpected success') {
      if (status !== 'ok' || !testResults.has(testId)) testResults.set(testId, status === 'ok' ? 'PASSED' : 'FAILED');
      if (!testName) testName = testId;
    }
  }

  totalTests = testResults.size;
  for (const status of testResults.values()) {
    if (status === 'PASSED') passedTests++;
    else failedTests++;
  }

  if (reportedTestFiles.size === 1) {
    const [filePath] = reportedTestFiles;
    const candidate = path.resolve(filePath);
    if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      testFilePath = candidate;
      testFileLines = countCodeLines(fs.readFileSync(testFilePath, 'utf-8'));
    }
  }

  // 如果有收集错误且没有解析到测试结果，设置默认测试名
  if (!testName && compileErrors) {
    testName = 'pytest_collection_error';
  }
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
    // Collection errors are not test cases and were never included in totalTests.
    compiled_testcase_num: totalTests,
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
    sourceFile: relativeSource,
    version: '1.0.0',
  },
  errorDetail: errorDetail,
};

// 每个源路径只替换自己的结果，不读取或删除其他模块的缓存。
const outputDir = path.join(process.cwd(), '.codecovcli', 'cache');
fs.mkdirSync(outputDir, { recursive: true });
const key = createHash('sha256').update(relativeSource).digest('hex');
const outputPath = path.join(outputDir, `python_${key}.json`);
const temporary = path.join(outputDir, `.${randomUUID()}.tmp`);
try {
  fs.writeFileSync(temporary, JSON.stringify(result, null, 2), { encoding: 'utf-8', flag: 'wx' });
  fs.renameSync(temporary, outputPath);
} catch (error) {
  fs.rmSync(temporary, { force: true });
  throw error;
}
console.log(`覆盖率文件已生成: ${outputPath}`);

// ========== 辅助函数 ==========

function fileIdentity(filePath) {
  const absolute = path.resolve(filePath.replace(/\\/g, '/'));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/**
 * 覆盖率数据校验
 * 检查总数是否为0或负数、覆盖行是否大于总行数
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

  return { valid: true };
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
  let inImport = false;
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

    // 括号内的多行导入到右括号为止；忽略注释中的括号。
    if (inImport) {
      if (/^[^#]*\)/.test(trimmed)) inImport = false;
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
    const fromImport = /^from\s+\S+\s+import\b([^#]*)/.exec(trimmed);
    if (fromImport) {
      const imported = fromImport[1].trimStart();
      inImport = imported.startsWith('(') && !imported.includes(')');
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
