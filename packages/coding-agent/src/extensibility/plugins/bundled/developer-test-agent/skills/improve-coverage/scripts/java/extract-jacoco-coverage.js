/**
 * 从 jacoco.xml 中提取指定类的覆盖率信息，从 surefire 报告中提取测试执行结果，
 * 生成 .codecovcli/cache 格式的 JSON 文件。
 *
 * 用法: node extract-jacoco-coverage.js <类名> <jacoco.xml路径> [surefire目录]
 * 示例: node extract-jacoco-coverage.js ConfigPublishEmailBuilder apollo-portal/target/site/jacoco/jacoco.xml
 *       node extract-jacoco-coverage.js ConfigPublishEmailBuilder apollo-portal/target/site/jacoco/jacoco.xml apollo-portal/target/surefire-reports
 *
 * 如果不指定 surefire 目录，会自动从 jacoco.xml 路径推断（同级 target/surefire-reports）。
 *
 * 输出: <cwd>/.codecovcli/cache/java_<类名>.json
 */

const fs = require('fs');
const path = require('path');

// ========== 参数解析 ==========
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('用法: node extract-jacoco-coverage.js <类名> <jacoco.xml路径> [surefire目录]');
  console.error('示例: node extract-jacoco-coverage.js ConfigPublishEmailBuilder apollo-portal/target/site/jacoco/jacoco.xml');
  process.exit(1);
}

const className = args[0];
const jacocoXmlPath = path.resolve(args[1]);
const surefireDirArg = args[2] ? path.resolve(args[2]) : null;

// ========== 读取 jacoco.xml ==========
if (!fs.existsSync(jacocoXmlPath)) {
  console.error(`文件不存在: ${jacocoXmlPath}`);
  process.exit(1);
}
const xml = fs.readFileSync(jacocoXmlPath, 'utf-8');

// ========== 查找目标类及其所在 package ==========
const packageRegex = /<package\s+name="([^"]+)">([\s\S]*?)<\/package>/g;
let pkgMatch;
let found = null;

while ((pkgMatch = packageRegex.exec(xml)) !== null) {
  const pkgName = pkgMatch[1];
  const pkgContent = pkgMatch[2];

  const classBlockRegex = /<class\s+name="([^"]+)"\s+sourcefilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g;
  let classMatch;
  while ((classMatch = classBlockRegex.exec(pkgContent)) !== null) {
    const fullName = classMatch[1];
    const sourceFile = classMatch[2];
    const classContent = classMatch[3];
    const simpleName = fullName.split('/').pop();
    const fullClassNameFromXml = fullName.replace(/\//g, '.');

    // 支持简单类名（如 PropertyCopier）或完整类名（如 org.apache.ibatis.reflection.property.PropertyCopier）
    if (simpleName === className || fullClassNameFromXml === className) {
      found = { fullName, sourceFile, classContent, pkgName, pkgContent };
      break;
    }
  }
  if (found) break;
}

if (!found) {
  console.error(`未在 jacoco.xml 中找到类: ${className}`);
  process.exit(1);
}

const fullClassName = found.fullName.replace(/\//g, '.');

// ========== 提取类级别的覆盖率计数器 ==========
const classContentWithoutMethods = found.classContent.replace(/<method[\s\S]*?<\/method>/g, '');

const lineMatch = /<counter\s+type="LINE"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/.exec(classContentWithoutMethods);
const lineMissed = lineMatch ? parseInt(lineMatch[1]) : 0;
const lineCovered = lineMatch ? parseInt(lineMatch[2]) : 0;
const totalLines = lineMissed + lineCovered;

const branchMatch = /<counter\s+type="BRANCH"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/.exec(classContentWithoutMethods);
const branchMissed = branchMatch ? parseInt(branchMatch[1]) : 0;
const branchCovered = branchMatch ? parseInt(branchMatch[2]) : 0;
const totalBranches = branchMissed + branchCovered;

const linePercentage = totalLines > 0 ? Math.round((lineCovered / totalLines) * 10000) / 100 : 0;
const branchPercentage = totalBranches > 0 ? Math.round((branchCovered / totalBranches) * 10000) / 100 : 0;

// ========== 覆盖率数据校验 ==========
const validation = validateCoverageData(totalLines, lineCovered);
if (!validation.valid) {
  console.error(`\n[ERROR] 覆盖率数据校验失败: ${validation.reason}`);
  console.error(`被测类: ${fullClassName}`);
  console.error(`总行数: ${totalLines}, 覆盖行数: ${lineCovered}`);
  process.exit(1);
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

// ========== 从 sourcefile 中提取行级覆盖详情 ==========
const missedLines = [];
const coveredLines = [];

const sourceFileRegex = new RegExp(
  `<sourcefile\\s+name="${escapeRegex(found.sourceFile)}"[^>]*>([\\s\\S]*?)<\\/sourcefile>`
);
const sfMatch = sourceFileRegex.exec(found.pkgContent);
if (sfMatch) {
  const lineRegex = /<line\s+nr="(\d+)"\s+mi="(\d+)"\s+ci="(\d+)"[^>]*\/>/g;
  let lm;
  while ((lm = lineRegex.exec(sfMatch[1])) !== null) {
    const nr = parseInt(lm[1]);
    const ci = parseInt(lm[3]);
    if (ci > 0) {
      coveredLines.push(nr);
    } else {
      missedLines.push(nr);
    }
  }
  missedLines.sort((a, b) => a - b);
  coveredLines.sort((a, b) => a - b);
}

// ========== 从 surefire 报告中提取测试执行结果 ==========
// 推断 surefire 目录：jacoco.xml 路径为 <module>/target/site/jacoco/jacoco.xml
// surefire 目录为 <module>/target/surefire-reports
let surefireDir = surefireDirArg;
if (!surefireDir) {
  const jacocoDir = path.dirname(jacocoXmlPath);                   // .../target/site/jacoco
  const siteDir = path.dirname(jacocoDir);                         // .../target/site
  const targetDir = path.dirname(siteDir);                         // .../target
  surefireDir = path.join(targetDir, 'surefire-reports');
}

// 推断 module 根目录（target 的父目录）
const jacocoDir = path.dirname(jacocoXmlPath);                     // .../target/site/jacoco
const siteDir = path.dirname(jacocoDir);                           // .../target/site
const targetDir = path.dirname(siteDir);                           // .../target
const moduleRoot = path.dirname(targetDir);                        // .../module

// 测试数据
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let skippedTests = 0;
let errors = 0;
let testName = '';
let testFileLines = 0;

if (fs.existsSync(surefireDir)) {
  // 搜索匹配的 surefire 报告文件
  // 命名规则: TEST-<fully.qualified.TestClassName>.xml
  // 测试类名尝试: ClassNameTest, ClassNameIT, ClassNameTestCase
  const testClassSuffixes = ['Test', 'IT', 'TestCase'];
  const pkgPrefix = found.fullName.substring(0, found.fullName.lastIndexOf('/') + 1); // com/ctrip/.../
  let surefireFile = null;

  for (const suffix of testClassSuffixes) {
    const testFullName = (pkgPrefix + className + suffix).replace(/\//g, '.');
    const candidate = path.join(surefireDir, `TEST-${testFullName}.xml`);
    if (fs.existsSync(candidate)) {
      surefireFile = candidate;
      testName = testFullName;
      break;
    }
  }

  // 如果精确匹配不到，模糊搜索包含类名的报告文件
  if (!surefireFile) {
    const files = fs.readdirSync(surefireDir);
    const pattern = new RegExp(`^TEST-.*${escapeRegex(className)}.*\\.xml$`);
    const matched = files.find(f => pattern.test(f));
    if (matched) {
      surefireFile = path.join(surefireDir, matched);
      testName = matched.replace(/^TEST-/, '').replace(/\.xml$/, '');
    }
  }

  if (surefireFile) {
    const surefireXml = fs.readFileSync(surefireFile, 'utf-8');
    const tsMatch = /<testsuite\s+[^>]*tests="(\d+)"[^>]*errors="(\d+)"[^>]*skipped="(\d+)"[^>]*failures="(\d+)"/.exec(surefireXml);
    if (tsMatch) {
      totalTests = parseInt(tsMatch[1]);
      errors = parseInt(tsMatch[2]);
      skippedTests = parseInt(tsMatch[3]);
      failedTests = parseInt(tsMatch[4]);
      passedTests = totalTests - errors - failedTests - skippedTests;
    }
  }
}

// 读取测试源文件行数（只计算实际代码行，排除 import、注释、空行）
if (testName) {
  const testFilePath = path.join(moduleRoot, 'src', 'test', 'java', ...testName.split('.')) + '.java';
  if (fs.existsSync(testFilePath)) {
    const testContent = fs.readFileSync(testFilePath, 'utf-8');
    testFileLines = countCodeLines(testContent);
  }
}

// ========== 控制台输出 ==========
console.log('');
console.log('============================================================');
console.log('  Java 代码覆盖率报告');
console.log('============================================================');
console.log('');
console.log('汇总信息：');
console.log('行覆盖率 (Line Coverage):');
printTable([
  ['已覆盖行数', String(lineCovered)],
  ['未覆盖行数', String(lineMissed)],
  ['总行数', String(totalLines)],
  ['覆盖率', `${linePercentage}%`],
  ['已覆盖分支数', String(branchCovered)],
  ['未覆盖分支数', String(branchMissed)],
  ['总分支数', String(totalBranches)],
  ['分支覆盖率', `${branchPercentage}%`],
]);
console.log('');
console.log(`被测类：${fullClassName}`);
if (testName) {
  console.log(`测试类：${testName}`);
  console.log(`测试用例数：${totalTests} (通过: ${passedTests}, 失败: ${failedTests}, 错误: ${errors}, 跳过: ${skippedTests})`);
}
console.log(`Missed Lines:`);
console.log(`  ${missedLines.join(', ')}`);
console.log(`Covered Lines:`);
console.log(`  ${coveredLines.join(', ')}`);

// ========== 构建输出 JSON ==========
const result = {
  className: className,
  testName: testName,
  scenario: "class-level",
  timestamp: new Date().toISOString(),
  lineCoverage: {
    totalLines: totalLines,
    coveredLines: lineCovered,
    missedLines: lineMissed,
    percentage: linePercentage
  },
  branchCoverage: {
    totalBranches: totalBranches,
    coveredBranches: branchCovered,
    missedBranches: branchMissed,
    percentage: branchPercentage
  },
  testResult: {
    totalTests: totalTests,
    passedTests: passedTests,
    failedTests: failedTests,
    skippedTests: skippedTests
  },
  metrics: {
    compiled_testcase_num: totalTests - errors,
    passed_testcase_num: passedTests,
    covered_line_num: lineCovered,
    total_compile_error_num: errors,
    total_line_num: totalLines,
    accept_testcase_num: passedTests,
    generate_testcase_num: totalTests,
    total_testcase_num: totalTests,
    accept_line_num: testFileLines,
    generate_line_num: testFileLines
  },
  metadata: {
    language: "java",
    projectDir: process.cwd(),
    version: "1.0.0"
  }
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

const outputPath = path.join(outputDir, `java_${className}.json`);
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
console.log(`覆盖率文件已生成: ${outputPath}`);

// ========== 辅助函数 ==========
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function padRight(str, width) {
  const dw = displayWidth(str);
  return str + ' '.repeat(Math.max(0, width - dw));
}

function padLeft(str, width) {
  const dw = displayWidth(str);
  return ' '.repeat(Math.max(0, width - dw)) + str;
}

// 统计 Java 源文件的实际代码行数（排除空行、注释、import、package）
function countCodeLines(content) {
  const lines = content.split('\n');
  let codeLines = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // 跳过空行
    if (trimmed === '') continue;

    // 处理多行注释内部
    if (inBlockComment) {
      if (trimmed.includes('*/')) {
        inBlockComment = false;
      }
      continue;
    }

    // 跳过 package / import 声明
    if (trimmed.startsWith('package ') || trimmed.startsWith('import ')) continue;

    // 跳过单行注释
    if (trimmed.startsWith('//')) continue;

    // 开始多行注释
    if (trimmed.startsWith('/*')) {
      if (!trimmed.endsWith('*/') && !trimmed.includes('*/')) {
        inBlockComment = true;
      }
      continue;
    }

    codeLines++;
  }

  return codeLines;
}
