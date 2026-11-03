/**
 * Run Codecheck Script
 * 执行 codecheck 本地检查，解析结果，过滤三种断言告警，通过 stdout JSON 输出
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 需要过滤的三种告警规则
const TARGET_RULES = [
  'Java是否存在断言检查',
  'Java是否虚假断言',
  'Java中途退出检查'
];

// codecheck 规则集配置
const RULE_SET_ID = '791646a9af594938bd9086d3912ef623';
const CHECK_TYPE = 'dtagent_testcodecheck';

function outputResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function outputError(projectDir, error, exitCode = 1) {
  outputResult({ success: false, error: error, alarmCount: 0, alarms: [] });
  process.exit(exitCode);
}

function runCommand(cmd, options = {}) {
  try {
    const result = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 300000, // 5 分钟超时
      ...options
    });
    return result;
  } catch (e) {
    return null;
  }
}

function filterAlarms(resultData) {
  const alarms = [];

  // resultData 可能是数组或包含数组的对象，兼容多种结构
  let alarmArray = [];
  if (Array.isArray(resultData)) {
    alarmArray = resultData;
  } else if (resultData && Array.isArray(resultData.diagnostics)) {
    alarmArray = resultData.diagnostics;
  } else if (resultData && Array.isArray(resultData.alarms)) {
    alarmArray = resultData.alarms;
  } else if (resultData && Array.isArray(resultData.defects)) {
    alarmArray = resultData.defects;
  } else if (resultData && Array.isArray(resultData.issues)) {
    alarmArray = resultData.issues;
  }

  for (const item of alarmArray) {
    const rule = item.criterionName || item.rule || item.checkerName || item.ruleName || '';
    if (TARGET_RULES.includes(rule)) {
      alarms.push({
        filePath: item.buggyFilePath || item.filePath || item.file || '',
        methodName: item.functionName || item.methodName || item.method || '',
        rule: rule,
        description: item.description || item.message || item.recommend || '',
        codeSnippet: item.mainBuggyCode || item.codeSnippet || item.codeContext || item.snippet || '',
        lineNumber: item.line || item.lineNumber || 0
      });
    }
  }

  return alarms;
}

function runCodecheck(projectDir, testFileRelativePath) {
  // Step 0: 通用初始化
  const generalInitResult = runCommand('codecheck init', { cwd: projectDir });
  if (generalInitResult === null) {
    outputError(projectDir, 'codecheck init failed');
    return;
  }

  // Step 1: 设置指定规则集
  const configResult = runCommand(`codecheck config rule-set-ids ${RULE_SET_ID} --type ${CHECK_TYPE}`, { cwd: projectDir });
  if (configResult === null) {
    outputError(projectDir, 'config rule-set-ids failed');
    return;
  }

  // Step 2: 初始化指定规则集
  const initResult = runCommand(`codecheck init --type ${CHECK_TYPE}`, { cwd: projectDir });
  if (initResult === null) {
    outputError(projectDir, 'init failed');
    return;
  }

  // Step 3: 执行全量检查
  const checkResult = runCommand(`codecheck fullcheck --files ${testFileRelativePath} --compiled --type ${CHECK_TYPE}`, { cwd: projectDir });
  if (checkResult === null) {
    outputError(projectDir, 'fullcheck failed');
    return;
  }

  // Step 4: 解析结果文件
  const resultFilePath = path.join(projectDir, '.codecheckcli', 'codecheck-result.json');
  if (!fs.existsSync(resultFilePath)) {
    outputResult({ success: true, alarmCount: 0, alarms: [] });
    return;
  }

  let resultData;
  try {
    const content = fs.readFileSync(resultFilePath, 'utf-8');
    resultData = JSON.parse(content);
  } catch (e) {
    outputResult({ success: true, alarmCount: 0, alarms: [] });
    return;
  }

  // Step 5: 过滤目标告警
  const alarms = filterAlarms(resultData);

  outputResult({
    success: true,
    alarmCount: alarms.length,
    alarms: alarms
  });
}

async function main() {
  const projectDir = process.argv[2];
  const testFileRelativePath = process.argv[3];

  if (!projectDir) {
    // 无法写日志，直接输出错误
    outputResult({ success: false, error: 'projectDir is required', alarmCount: 0, alarms: [] });
    process.exit(1);
    return;
  }

  if (!testFileRelativePath) {
    outputError(projectDir, 'testFileRelativePath is required');
    return;
  }

  if (!fs.existsSync(projectDir)) {
    outputError(projectDir, `projectDir does not exist: ${projectDir}`);
    return;
  }

  if (path.isAbsolute(testFileRelativePath)) {
    outputError(projectDir, 'testFileRelativePath must be a relative path, not absolute');
    return;
  }

  runCodecheck(projectDir, testFileRelativePath);
}

if (require.main === module) {
  main().catch(e => {
    const projectDir = process.argv[2];
    if (projectDir) {
      outputError(projectDir, e.message);
    } else {
      outputResult({ success: false, error: e.message, alarmCount: 0, alarms: [] });
      process.exit(1);
    }
  });
}

module.exports = { runCodecheck, filterAlarms, TARGET_RULES, RULE_SET_ID, CHECK_TYPE };
