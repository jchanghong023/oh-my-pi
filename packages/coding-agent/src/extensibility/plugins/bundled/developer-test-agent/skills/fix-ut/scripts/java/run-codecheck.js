/**
 * Run Codecheck Script
 * 执行 codecheck 本地检查，解析结果，过滤三种断言告警，通过 stdout JSON 输出
 */

const { execFileSync } = require('child_process');
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

function outputError(error) {
  outputResult({ success: false, error, alarmCount: 0, alarms: [] });
  process.exit(1);
}

function runCommand(args, cwd) {
  try {
    const commandOptions = {
      encoding: 'utf-8',
      timeout: 300000, // 5 分钟超时
      cwd
    };
    if (process.platform !== 'win32') {
      return execFileSync('codecheck', args, commandOptions);
    }

    // npm 在 Windows 上使用 .cmd 启动器；通过环境变量传入带引号的参数。
    const env = { ...process.env };
    const commandArgs = args.map((arg, index) => {
      if (/["\r\n]/.test(arg)) {
        throw new Error('Invalid Windows command argument');
      }
      const name = `OMP_CODECHECK_ARG_${index}`;
      env[name] = arg;
      return `"%${name}%"`;
    });
    return execFileSync(process.env.ComSpec || 'cmd.exe', [
      '/d', '/v:off', '/s', '/c', `"codecheck ${commandArgs.join(' ')}"`
    ], { ...commandOptions, env, windowsVerbatimArguments: true });
  } catch (e) {
    return null;
  }
}

function filterAlarms(resultData) {
  const alarms = [];

  // resultData 可能是数组或包含数组的对象，兼容多种结构
  let alarmArray;
  if (Array.isArray(resultData)) {
    alarmArray = resultData;
  } else if (Array.isArray(resultData?.diagnostics)) {
    alarmArray = resultData.diagnostics;
  } else if (Array.isArray(resultData?.alarms)) {
    alarmArray = resultData.alarms;
  } else if (Array.isArray(resultData?.defects)) {
    alarmArray = resultData.defects;
  } else if (Array.isArray(resultData?.issues)) {
    alarmArray = resultData.issues;
  } else {
    throw new Error('Codecheck result does not contain an alarm array');
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
  const generalInitResult = runCommand(['init'], projectDir);
  if (generalInitResult === null) {
    outputError('codecheck init failed');
  }

  // Step 1: 设置指定规则集
  const configResult = runCommand(['config', 'rule-set-ids', RULE_SET_ID, '--type', CHECK_TYPE], projectDir);
  if (configResult === null) {
    outputError('config rule-set-ids failed');
  }

  // Step 2: 初始化指定规则集
  const initResult = runCommand(['init', '--type', CHECK_TYPE], projectDir);
  if (initResult === null) {
    outputError('init failed');
  }

  // Step 3: 执行全量检查
  const checkResult = runCommand(
    ['fullcheck', '--files', testFileRelativePath, '--compiled', '--type', CHECK_TYPE],
    projectDir
  );
  if (checkResult === null) {
    outputError('fullcheck failed');
  }

  // Step 4: 解析结果文件
  const resultFilePath = path.join(projectDir, '.codecheckcli', 'codecheck-result.json');

  let alarms;
  try {
    const content = fs.readFileSync(resultFilePath, 'utf-8');
    alarms = filterAlarms(JSON.parse(content));
  } catch (e) {
    outputError(`Failed to load Codecheck result: ${e.message}`);
  }

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
    outputError('projectDir is required');
  }

  if (!testFileRelativePath) {
    outputError('testFileRelativePath is required');
  }

  if (!fs.existsSync(projectDir)) {
    outputError(`projectDir does not exist: ${projectDir}`);
  }

  if (path.isAbsolute(testFileRelativePath)) {
    outputError('testFileRelativePath must be a relative path, not absolute');
  }

  runCodecheck(projectDir, testFileRelativePath);
}

if (require.main === module) {
  main().catch(e => outputError(e.message));
}

module.exports = { runCodecheck, filterAlarms, TARGET_RULES, RULE_SET_ID, CHECK_TYPE };
