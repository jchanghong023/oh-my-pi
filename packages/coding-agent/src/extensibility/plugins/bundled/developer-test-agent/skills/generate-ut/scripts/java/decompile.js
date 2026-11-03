/**
 * 二方件反编译脚本
 * 通过 mvn dependency:tree 获取 pom 中实际引入的版本，只反编译需要的版本
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function getSkillDir() {
  return path.dirname(require.resolve('./decompile.js'));
}

function getCfrPath() {
  return path.join(getSkillDir(), '..', '..', 'assets', 'java', 'cfr-0.152.jar');
}

function getDefaultM2Repo() {
  const home = process.env.HOME || process.env.USERPROFILE;
  return path.join(home, '.m2', 'repository');
}

function locateMavenJar(groupId, artifactId, version, m2Repo) {
  const groupPath = groupId.replace(/\./g, '/');
  const jarName = `${artifactId}-${version}.jar`;
  return path.join(m2Repo, groupPath, artifactId, version, jarName);
}

function locateMavenJarWithClassifier(groupId, artifactId, version, classifier, m2Repo) {
  const groupPath = groupId.replace(/\./g, '/');
  const jarName = `${artifactId}-${version}-${classifier}.jar`;
  return path.join(m2Repo, groupPath, artifactId, version, jarName);
}

function parseJarPath(jarPath, expectedClassifier) {
  const fileName = path.basename(jarPath, '.jar');
  const dir = path.dirname(jarPath);
  const parts = dir.split(/[/\\]/);
  
  let artifactId, version;
  const match = fileName.match(/^(.+)-((?:\d+\.)+\d+(?:-(?:SNAPSHOT|RELEASE|[a-z0-9]+(?:\.[a-z0-9]+)*))*)$/i);
  if (!match) return null;
  
  artifactId = match[1];
  version = match[2];
  
  let versionMatch;
  if (expectedClassifier) {
    const escapedClassifier = expectedClassifier.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    versionMatch = version.match(new RegExp(`^((?:\\d+\\.)+\\d+(?:-(?:SNAPSHOT|RELEASE))?(?:-(?!(?:${escapedClassifier})$)[a-z0-9]+(?:\\.[a-z0-9]+)*)*)(?:-${escapedClassifier})?$`, 'i'));
  } else {
    versionMatch = version.match(/^((?:\d+\.)+\d+(?:-(?:SNAPSHOT|RELEASE))?(?:-(?!(?:sources|javadoc|tests|vm|all|bundle|shade|fat|uber|assembly|executable|war|ear|jar|zip|tar\.gz|tgz)$)[a-z0-9]+(?:\.[a-z0-9]+)*)*)(?:-(sources|javadoc|tests|vm|all|bundle|shade|fat|uber|assembly|executable|war|ear|jar|zip|tar\.gz|tgz))?$/i);
  }
  
  if (versionMatch) {
    version = versionMatch[1];
  }
  
  const versionIndex = parts.findIndex(p => p === version);
  if (versionIndex < 2) return null;
  
  const repoIndex = parts.findIndex(p => p === 'repository');
  const groupIdParts = repoIndex >= 0 
    ? parts.slice(repoIndex + 1, versionIndex - 1)
    : parts.slice(0, versionIndex - 1);
  
  const groupId = groupIdParts.join('.');
  
  return { groupId, artifactId, version };
}

function parseMavenParams(m2Params) {
  const params = {};
  if (!m2Params) return params;
  const regex = /-D([^=]+)=([^\s]+)/g;
  let match;
  while ((match = regex.exec(m2Params)) !== null) {
    params[match[1]] = match[2];
  }
  return params;
}

function resolveVariable(variable, mavenParams) {
  if (mavenParams[variable]) {
    return mavenParams[variable];
  }
  return variable;
}

function runMvnDependencyTree(projectDir, m2Params, settings) {
  return new Promise((resolve, reject) => {
    const mvnCmd = process.platform === 'win32' ? 'mvn.cmd' : 'mvn';
    const args = ['dependency:tree'];

    if (settings) {
      args.push('-s', settings);
    }

    if (m2Params) {
      const params = m2Params.split(/\s+/);
      args.push(...params);
    }

    const useShell = process.platform === 'win32';
    const spawnArgs = useShell ? [mvnCmd, ...args] : args;
    const spawnCmd = useShell ? process.env.ComSpec || 'cmd.exe' : mvnCmd;
    const spawnOpts = useShell
      ? { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true }
      : { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] };
    const child = spawn(spawnCmd, useShell ? ['/c', ...spawnArgs] : spawnArgs, spawnOpts);

    let stdout = '', stderr = '';
    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`mvn dependency:tree failed with code ${code}:\n${stdout}\n${stderr}`));
      }
    });
    child.on('error', reject);
  });
}

// 创建去除 mirror 的临时 settings.xml
function createNoMirrorSettings(settingsPath) {
  if (!settingsPath || !fs.existsSync(settingsPath)) return null;

  const content = fs.readFileSync(settingsPath, 'utf-8');
  // Remove everything between <mirror> and </mirror> tags (including nested content)
  const noMirror = content.replace(/<mirror>[\s\S]*?<\/mirror>/g, '');

  const os = require('os');
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `settings-nomirror-${Date.now()}.xml`);
  fs.writeFileSync(tmpPath, noMirror);
  return tmpPath;
}

function parseDependencyTree(content, mavenParams) {
  const deps = [];
  const lines = content.split('\n');
  
  for (const line of lines) {
    let match = line.match(/([\w.-]+):([\w.-]+):(\w+):([^:]+):([\w.-]+):(\w+)/);
    if (match) {
      const [, groupId, artifactId, type, classifier, version, scope] = match;
      if (type === 'jar') {
        const isVariableClassifier = classifier.startsWith('${') && classifier.endsWith('}');
        let resolvedClassifier;
        if (isVariableClassifier) {
          const variableName = classifier.slice(2, -1);
          resolvedClassifier = resolveVariable(variableName, mavenParams);
        } else {
          resolvedClassifier = classifier;
        }
        deps.push({ groupId, artifactId, version, scope, classifier: resolvedClassifier });
      }
      continue;
    }
    
    match = line.match(/([\w.-]+):([\w.-]+):(\w+):([\w.-]+):(\w+)/);
    if (match) {
      const [, groupId, artifactId, type, version, scope] = match;
      if (type === 'jar') {
        deps.push({ groupId, artifactId, version, scope });
      }
    }
  }
  
  return deps;
}

function globToRegex(pattern) {
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2).replace(/\./g, '\\.');
    return new RegExp(`^${prefix}(?:\\..+)?$`);
  }
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*');
  return new RegExp(`^${regexPattern}$`);
}

async function getDepsFromPom(projectDir, packagePatterns, m2Repo, m2Params, settings) {
  function parseAndFilter(output) {
    const mavenParams = parseMavenParams(m2Params);
    const allDeps = parseDependencyTree(output, mavenParams);

    const filteredDeps = [];
    const seen = new Set();

    const regexes = packagePatterns.map(p => globToRegex(p));

    for (const dep of allDeps) {
      const matches = regexes.some(regex => regex.test(dep.groupId));
      if (matches) {
        const key = `${dep.groupId}:${dep.artifactId}:${dep.version}:${dep.classifier || ''}`;
        if (!seen.has(key)) {
          seen.add(key);

          let jarPath;
          if (dep.classifier) {
            jarPath = locateMavenJarWithClassifier(dep.groupId, dep.artifactId, dep.version, dep.classifier, m2Repo);
          } else {
            jarPath = locateMavenJar(dep.groupId, dep.artifactId, dep.version, m2Repo);
          }

          filteredDeps.push({
            groupId: dep.groupId,
            artifactId: dep.artifactId,
            version: dep.version,
            classifier: dep.classifier,
            jarPath
          });
        }
      }
    }
    return filteredDeps;
  }

  // 第一次尝试：使用原始 settings
  try {
    const output = await runMvnDependencyTree(projectDir, m2Params, settings);
    return { deps: parseAndFilter(output), failed: false };
  } catch (firstError) {
    // 检查是否是 mirror 导致的 parent POM 解析失败
    const errMsg = firstError.message || '';
    const isMirrorIssue = errMsg.includes('mirror') || errMsg.includes('mirrorOf') ||
      (errMsg.includes('parent POM') && errMsg.includes('not found'));

    if (!isMirrorIssue || !settings) {
      return { deps: [], failed: true, error: firstError.message };
    }

    // 第二次尝试：去除 mirror 的 settings 重试
    console.log('检测到可能是 Maven mirror 导致的 parent POM 解析失败，尝试去除 mirror 重试...');
    let noMirrorSettings = null;
    try {
      noMirrorSettings = createNoMirrorSettings(settings);
      const output = await runMvnDependencyTree(projectDir, m2Params, noMirrorSettings);
      return { deps: parseAndFilter(output), failed: false };
    } catch (retryError) {
      return { deps: [], failed: true, error: `原始错误: ${firstError.message}\n去mirror重试错误: ${retryError.message}` };
    } finally {
      if (noMirrorSettings) {
        try { fs.unlinkSync(noMirrorSettings); } catch (_) {}
      }
    }
  }
}

// 调用 CFR 反编译
function decompileJar(jarPath, outputDir, cfrPath) {
  return new Promise((resolve, reject) => {
    const args = ['-jar', cfrPath, jarPath, '--outputdir', outputDir];
    const child = spawn('java', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    
    let stderr = '';
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    
    child.on('close', (code) => {
      if (code === 0) resolve(outputDir);
      else reject(new Error(`CFR failed: ${stderr}`));
    });
    child.on('error', reject);
  });
}

// 生成索引
function generateIndex(depsDir) {
  const index = {};
  
  function scanDir(dir, relativePath) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const relPath = relativePath ? path.join(relativePath, item) : item;
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        scanDir(fullPath, relPath);
      } else if (item.endsWith('.java')) {
        const pathParts = relPath.split(/[/\\]/);
        let packageStartIndex = -1;
        
        // 查找包含版本号格式的目录（如 xxx-26.555.1441），跳过它
        for (let i = 0; i < pathParts.length; i++) {
          const part = pathParts[i];
          // 检测版本号格式：artifactId-version 格式（包含数字版本号）
          if (part && /\-\d+\.\d+/.test(part)) {
            // 找到版本号目录，包名从下一个目录开始
            packageStartIndex = i + 1;
            break;
          }
        }
        
        // 如果没找到版本号目录，使用原有逻辑
        if (packageStartIndex === -1) {
          for (let i = 0; i < pathParts.length; i++) {
            const part = pathParts[i];
            if (part && /^[a-z]/.test(part) && !/\-\d+\.\d+/.test(part)) {
              packageStartIndex = i;
              break;
            }
          }
        }
        
        if (packageStartIndex === -1 || packageStartIndex >= pathParts.length) {
          packageStartIndex = 0;
        }
        
        const classNameParts = pathParts.slice(packageStartIndex);
        const className = classNameParts.join('.').replace(/\.java$/, '');
        index[className] = relPath;
      }
    }
  }
  
  if (fs.existsSync(depsDir)) scanDir(depsDir, '');
  return index;
}

// 主函数
async function main(args) {
  const { packages, m2Repo, depsDir, projectDir, m2Params, settings } = args;
  
  console.log('开始反编译二方件...');
  console.log(`包名范围: ${packages.join(', ')}`);
  console.log(`Maven 仓库: ${m2Repo}`);
  console.log('');
  
  if (!projectDir) {
    console.log('错误: 需要提供 projectDir 参数（项目目录路径）');
    return;
  }
  
  if (!fs.existsSync(projectDir)) {
    console.log(`错误: 项目目录不存在: ${projectDir}`);
    return;
  }
  
  const pomPath = path.join(projectDir, 'pom.xml');
  if (!fs.existsSync(pomPath)) {
    console.log(`错误: 项目目录中没有 pom.xml: ${projectDir}`);
    return;
  }
  
  if (!fs.existsSync(depsDir)) {
    fs.mkdirSync(depsDir, { recursive: true });
  }
  
  console.log('从 pom 获取依赖版本...');
  const pomResult = await getDepsFromPom(projectDir, packages, m2Repo, m2Params, settings);

  if (pomResult.failed) {
    console.log(`警告: mvn dependency:tree 执行失败: ${pomResult.error}`);
    console.log('跳过反编译，避免扫描本地仓库产生大量无用文件');
    return;
  }

  const filteredDeps = pomResult.deps;
  console.log(`从 pom 获取到 ${filteredDeps.length} 个依赖`);
  console.log('');
  
  if (filteredDeps.length === 0) {
    console.log('未找到匹配的依赖');
    return;
  }
  
  const jars = [];
  for (const dep of filteredDeps) {
    if (fs.existsSync(dep.jarPath)) {
      jars.push({ ...dep, jarPath: dep.jarPath });
    } else {
      console.log(`警告: jar 文件不存在: ${dep.jarPath}`);
    }
  }
  
  console.log(`有效 jar 文件: ${jars.length} 个`);
  console.log('');
  
  const cfrPath = getCfrPath();
  let success = 0, skipped = 0, failed = 0;
  
  for (let i = 0; i < jars.length; i++) {
    const dep = jars[i];
    const classifierSuffix = dep.classifier ? `-${dep.classifier}` : '';
    const jarName = `${dep.artifactId}-${dep.version}${classifierSuffix}`;
    const jarOutputDir = path.join(depsDir, jarName);
    
    console.log(`[${i + 1}/${jars.length}] 反编译 ${jarName}.jar...`);
    
    try {
      const versionsPath = path.join(depsDir, 'versions.json');
      let versions = {};
      if (fs.existsSync(versionsPath)) {
        versions = JSON.parse(fs.readFileSync(versionsPath, 'utf-8'));
      }
      
      const key = `${dep.groupId}:${dep.artifactId}`;
      const currentVersion = dep.classifier ? `${dep.version}-${dep.classifier}` : dep.version;
      if (versions[key] && versions[key].version === currentVersion && fs.existsSync(jarOutputDir)) {
        console.log(`  跳过 (版本未变化)`);
        skipped++;
        continue;
      }
      
      await decompileJar(dep.jarPath, jarOutputDir, cfrPath);
      
      versions[key] = {
        groupId: dep.groupId,
        artifactId: dep.artifactId,
        version: currentVersion,
        jarPath: dep.jarPath,
        decompiledAt: new Date().toISOString()
      };
      fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2));
      
      console.log(`  完成`);
      success++;
    } catch (error) {
      console.log(`  失败: ${error.message}`);
      failed++;
    }
  }
  
  console.log('');
  console.log('反编译完成！');
  console.log(`成功: ${success}`);
  console.log(`跳过: ${skipped}`);
  console.log(`失败: ${failed}`);
  
  console.log('');
  console.log('生成索引...');
  const index = generateIndex(depsDir);
  const indexPath = path.join(depsDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`索引已更新，共 ${Object.keys(index).length} 个类`);
}

// 导出工具函数供 Skill 调用
module.exports = { main, getDepsFromPom, parseJarPath, generateIndex, parseDependencyTree, runMvnDependencyTree, parseMavenParams, resolveVariable };