/**
 * 二方件查询脚本
 * 快速查找二方件源码文件路径
 */

const fs = require('fs');
const path = require('path');

/**
 * 创建 BinaryDetector 实例
 * @param depsDir .dtagent/deps 目录路径
 */
function createBinaryDetector(depsDir) {
  // 加载 index.json（类名 → 文件路径映射）
  function loadIndex() {
    const indexPath = path.join(depsDir, 'index.json');
    if (!fs.existsSync(indexPath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(indexPath, 'utf-8');
      return JSON.parse(content);
    } catch (e) {
      console.error('Failed to load index.json:', e);
      return null;
    }
  }

  // 智能查找：支持精确匹配、类名匹配
  function findClass(index, className) {
    const results = [];
    const targetName = className.trim();
    const simpleName = targetName.substring(targetName.lastIndexOf('.') + 1);
    
    // 1. 精确匹配
    if (index[targetName]) {
      results.push({className: targetName, sourceFile: index[targetName], matchType: 'exact'});
      return results;
    }
    
    // 2. 只比较类名（忽略包名）
    const allKeys = Object.keys(index);
    for (const key of allKeys) {
      const idx = key.lastIndexOf('.');
      if (idx !== -1) {
        const keySimpleName = key.substring(idx + 1);
        if (keySimpleName === simpleName) {
          results.push({className: key, sourceFile: index[key], matchType: 'simpleName'});
        }
      }
    }
    
    return results;
  }

  // 转换为绝对路径
  function toAbsolutePath(relativePath) {
    const normalized = relativePath.replace(/\\/g, '/');
    return path.join(depsDir, normalized).replace(/\\/g, '/');
  }

  return {
    /**
     * 查找二方件类的源码文件路径（返回绝对路径）
     */
    findBinarySource(className) {
      const index = loadIndex();
      if (!index) {
        return JSON.stringify({success: false, error: "未找到 .dtagent/deps/index.json，请先运行 dtagent init --decompile"});
      }

      const results = findClass(index, className);
      
      const resultsWithAbsPath = results.map(r => ({
        className: r.className,
        sourceFile: r.sourceFile,
        absolutePath: toAbsolutePath(r.sourceFile),
        matchType: r.matchType
      }));
      
      if (results.length === 0) {
        return JSON.stringify({
          success: false,
          className: className,
          matches: [],
          tip: "未找到匹配。请检查：(1) 类名是否正确；(2) 是否已反编译该依赖"
        });
      }
      
      return JSON.stringify({
        success: true,
        className: className,
        matches: resultsWithAbsPath
      });
    },

    /**
     * 批量查找多个类的源码路径（返回绝对路径）
     */
    batchFindSource(classNames) {
      const index = loadIndex();
      if (!index) {
        return JSON.stringify({success: false, error: "未找到 .dtagent/deps/index.json"});
      }

      const classNameList = classNames
        .split(',')
        .map(c => c.trim())
        .filter(c => c.length > 0);

      const found = {};
      const missing = [];

      for (const className of classNameList) {
        const results = findClass(index, className);
        if (results.length > 0) {
          const resultsWithAbsPath = results.map(r => ({
            className: r.className,
            sourceFile: r.sourceFile,
            absolutePath: toAbsolutePath(r.sourceFile),
            matchType: r.matchType
          }));
          found[className] = resultsWithAbsPath;
        } else {
          missing.push(className);
        }
      }

      return JSON.stringify({
        success: true,
        found: found,
        missing: missing,
        depsDir: depsDir
      }, null, 2);
    },

    /**
     * 列出所有已反编译的二方件类
     */
    listBinaryClasses(filter, limit = 50) {
      const index = loadIndex();
      if (!index) {
        return "未找到 .dtagent/deps/index.json";
      }

      let classes = Object.keys(index);
      
      if (filter) {
        classes = classes.filter(className => className.startsWith(filter));
      }

      const limitedClasses = classes.slice(0, limit);

      return `二方件类列表 (共 ${classes.length} 个)\n\n${limitedClasses.join('\n')}${classes.length > limit ? '\n... 还有 ' + (classes.length - limit) + ' 个' : ''}`;
    }
  };
}

/**
 * 解析命令行参数，支持 --project-dir 参数
 * @returns {projectDir: string, command: string, args: string[]}
 */
function parseArgs() {
  const rawArgs = process.argv.slice(2);
  let projectDir = null;
  const remainingArgs = [];
  
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--project-dir' && i + 1 < rawArgs.length) {
      projectDir = rawArgs[i + 1];
      i++;
    } else {
      remainingArgs.push(rawArgs[i]);
    }
  }
  
  return { projectDir, command: remainingArgs[0], args: remainingArgs.slice(1) };
}

/**
 * 查找项目根目录（包含 .dtagent/deps/index.json 的目录）
 * @param startDir 起始目录
 * @returns 项目根目录或 null
 */
function findProjectRoot(startDir) {
  let currentDir = startDir;
  const root = path.parse(currentDir).root;
  
  while (currentDir !== root) {
    const indexPath = path.join(currentDir, '.dtagent', 'deps', 'index.json');
    if (fs.existsSync(indexPath)) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  
  return null;
}

/**
 * 验证并获取项目目录
 * @param explicitProjectDir 用户显式指定的项目目录
 * @returns 验证后的项目目录，或抛出错误
 */
function validateAndGetProjectDir(explicitProjectDir) {
  let projectDir;
  
  if (explicitProjectDir) {
    if (!fs.existsSync(explicitProjectDir)) {
      return { error: `指定的项目目录不存在: ${explicitProjectDir}` };
    }
    projectDir = explicitProjectDir;
  } else {
    const cwd = process.cwd();
    projectDir = findProjectRoot(cwd);
    if (!projectDir) {
      return { 
        error: `无法找到项目根目录（包含 .dtagent/deps/index.json）。\n当前工作目录: ${cwd}\n请使用 --project-dir 参数指定项目目录，或在项目根目录下执行脚本。`
      };
    }
  }
  
  const depsDir = path.join(projectDir, '.dtagent', 'deps');
  const indexPath = path.join(depsDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    return { error: `项目目录 ${projectDir} 中未找到 .dtagent/deps/index.json，请先运行反编译命令。` };
  }
  
  return { projectDir, depsDir };
}

// 如果直接运行此脚本
if (require.main === module) {
  const { projectDir: explicitProjectDir, command, args } = parseArgs();
  
  const result = validateAndGetProjectDir(explicitProjectDir);
  if (result.error) {
    console.log(JSON.stringify({ success: false, error: result.error }));
    process.exit(1);
  }
  
  const { projectDir, depsDir } = result;
  const detector = createBinaryDetector(depsDir);
  
  if (command === 'find-binary-source' && args[0]) {
    console.log(detector.findBinarySource(args[0]));
  } else if (command === 'batch-find-source' && args[0]) {
    console.log(detector.batchFindSource(args[0]));
  } else if (command === 'list-binary-classes') {
    const filter = args[0] || '';
    const limit = args[1] ? parseInt(args[1]) : 50;
    console.log(detector.listBinaryClasses(filter, limit));
  } else {
    console.log('Usage:');
    console.log('  node binary-detector.js --project-dir <projectDir> find-binary-source <className>');
    console.log('  node binary-detector.js --project-dir <projectDir> batch-find-source <classNames>');
    console.log('  node binary-detector.js --project-dir <projectDir> list-binary-classes [filter] [limit]');
    console.log('');
    console.log('Options:');
    console.log('  --project-dir  项目根目录路径（可选，若不指定则自动查找）');
    console.log('');
    console.log('Examples:');
    console.log('  node binary-detector.js --project-dir /path/to/project find-binary-source "RestfulResponse"');
    console.log('  node binary-detector.js find-binary-source "RestfulResponse"  # 自动查找项目根目录');
  }
}

module.exports = { createBinaryDetector };