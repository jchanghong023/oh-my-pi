/**
 * 二方件反编译脚本
 * 通过 mvn dependency:tree 获取 pom 中实际引入的版本，只反编译需要的版本
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { createHash } = require('crypto');

function getSkillDir() {
  return path.dirname(require.resolve('./decompile.js'));
}

function getCfrPath() {
  return path.join(getSkillDir(), '..', '..', 'assets', 'java', 'cfr-0.152.jar');
}

function resolveInputPath(input, base = process.cwd()) {
  return /^~(?:[/\\]|$)/.test(input)
    ? path.resolve(path.join(os.homedir(), input.slice(2)))
    : path.resolve(base, input);
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

function mavenArgs(m2Params) {
  return Array.isArray(m2Params) ? m2Params : (m2Params?.match(/\S+/g) || []);
}

function parseMavenParams(m2Params) {
  const params = Object.create(null);
  const args = mavenArgs(m2Params);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-D')) continue;
    const property = args[i] === '-D' ? args[++i] : args[i].slice(2);
    const equal = property?.indexOf('=') ?? -1;
    if (equal > 0) params[property.slice(0, equal)] = property.slice(equal + 1);
  }
  return params;
}

function resolveVariable(variable, mavenParams) {
  if (mavenParams[variable]) {
    return mavenParams[variable];
  }
  return variable;
}

function resolveMavenRepo(projectDir, m2Repo, m2Params, settings) {
  if (m2Repo) return resolveInputPath(m2Repo);
  const override = parseMavenParams(m2Params)['maven.repo.local'];
  if (override) return resolveInputPath(override, projectDir);

  if (settings && fs.existsSync(settings)) {
    const xml = fs.readFileSync(settings, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
    const localRepo = /<localRepository>\s*([^<]+?)\s*<\/localRepository>/.exec(xml)?.[1];
    if (localRepo) {
      const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      const repo = localRepo
        .replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity) =>
          entity[0] === '#'
            ? String.fromCodePoint(Number(entity[1] === 'x' ? `0${entity.slice(1)}` : entity.slice(1)))
            : entities[entity])
        .replace(/\$\{([^}]+)\}/g, (expression, name) =>
          name === 'user.home' ? os.homedir()
            : name.startsWith('env.') ? (process.env[name.slice(4)] ?? expression)
            : expression);
      return resolveInputPath(repo, projectDir);
    }
  }

  return resolveInputPath('~/.m2/repository');
}

function runMvnDependencyTree(projectDir, m2Params, settings) {
  return new Promise((resolve, reject) => {
    const args = ['dependency:tree'];

    if (settings) {
      args.push('-s', settings);
    }

    args.push(...mavenArgs(m2Params));

    const spawnOpts = { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] };
    let child;
    if (process.platform === 'win32') {
      const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' };
      const quotedArgs = args.map((arg, i) => {
        if (/["\0\r\n]/.test(arg)) {
          throw new Error('Maven arguments on Windows cannot contain quotes, NUL, CR or LF');
        }
        // Expand each value once inside cmd quotes, without interpreting percent signs in it.
        // Double trailing backslashes for the closing quote when Maven forwards argv to Java.
        const name = `OMP_DTAGENT_MVN_ARG_${i}`;
        env[name] = arg.replace(/\\+$/, '$&$&');
        return `"%${name}%"`;
      });
      const command = `"mvn.cmd ${quotedArgs.join(' ')}"`;
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/v:off', '/c', command], {
        ...spawnOpts,
        env,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn('mvn', args, spawnOpts);
    }

    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

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
function createNoMirrorSettings(settingsPath, tmpDir) {
  if (process.platform === 'win32') {
    // Windows ignores POSIX permission bits. Restrict the empty directory before writing settings.
    const systemDir = path.join(process.env.SystemRoot, 'System32');
    const identity = execFileSync(path.join(systemDir, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const sid = /,"(S-\d+(?:-\d+)+)"\s*$/.exec(identity)?.[1];
    if (!sid) throw new Error('无法确定 Maven 临时目录的 Windows 用户 SID');
    const icacls = path.join(systemDir, 'icacls.exe');
    execFileSync(icacls, [tmpDir, '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
    execFileSync(icacls, [tmpDir, '/inheritance:r'], { windowsHide: true });
  }

  const content = fs.readFileSync(settingsPath, 'utf-8');
  // Remove everything between <mirror> and </mirror> tags (including nested content)
  const noMirror = content.replace(/<mirror>[\s\S]*?<\/mirror>/g, '');
  const tmpPath = path.join(tmpDir, 'settings.xml');
  fs.writeFileSync(tmpPath, noMirror, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  return tmpPath;
}

function parseDependencyTree(content, mavenParams) {
  const deps = [];
  const lines = content.split('\n');
  
  for (const line of lines) {
    let match = line.match(/([\w.-]+):([\w.-]+):([\w-]+):([\w.-]+|\$\{[^}]+\}):([\w.-]+):(\w+)/);
    if (match) {
      const [, groupId, artifactId, type, classifier, version, scope] = match;
      if (type === 'jar' || type === 'test-jar') {
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
    
    match = line.match(/([\w.-]+):([\w.-]+):([\w-]+):([\w.-]+):(\w+)/);
    if (match) {
      const [, groupId, artifactId, type, version, scope] = match;
      if (type === 'jar' || type === 'test-jar') {
        deps.push({ groupId, artifactId, version, scope, classifier: type === 'test-jar' ? 'tests' : undefined });
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
    const isMirrorIssue = errMsg.includes('mirror') ||
      (errMsg.includes('parent POM') && errMsg.includes('not found'));

    if (!isMirrorIssue || !settings || !fs.existsSync(settings)) {
      return { deps: [], failed: true, error: firstError.message };
    }

    // 第二次尝试：去除 mirror 的 settings 重试
    console.log('检测到可能是 Maven mirror 导致的 parent POM 解析失败，尝试去除 mirror 重试...');
    let noMirrorDir;
    try {
      noMirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtagent-maven-'));
      const noMirrorSettings = createNoMirrorSettings(settings, noMirrorDir);
      const output = await runMvnDependencyTree(projectDir, m2Params, noMirrorSettings);
      return { deps: parseAndFilter(output), failed: false };
    } catch (retryError) {
      return { deps: [], failed: true, error: `原始错误: ${firstError.message}\n去mirror重试错误: ${retryError.message}` };
    } finally {
      if (noMirrorDir) {
        try {
          fs.rmSync(noMirrorDir, { recursive: true, force: true });
        } catch (error) {
          console.warn(`警告: 无法清理 Maven 临时目录: ${error.message}`);
        }
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
function generateIndex(depsDir, jarOutputDirs) {
  const index = Object.create(null);

  function scanDir(dir, relativePath, packagePrefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = path.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        scanDir(path.join(dir, entry.name), relPath, `${packagePrefix}${entry.name}.`);
      } else if (entry.isFile() && entry.name.endsWith('.java')) {
        index[`${packagePrefix}${entry.name.slice(0, -5)}`] = relPath;
      }
    }
  }

  for (const entry of fs.readdirSync(depsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(depsDir, entry.name);
    if (!jarOutputDirs.has(dir)) scanDir(dir, entry.name, '');
  }
  // Current dependencies take precedence over older cached copies of the same class.
  for (const dir of jarOutputDirs) {
    if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      scanDir(dir, path.relative(depsDir, dir), '');
    }
  }
  return index;
}

async function hashJar(jarPath) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(jarPath)) hash.update(chunk);
  return hash.digest('hex');
}

// 主函数
async function main(args) {
  const { packages, projectDir: inputProjectDir, m2Params } = args;
  console.log('开始反编译二方件...');
  console.log(`包名范围: ${packages.join(', ')}`);
  console.log('');
  
  if (!inputProjectDir) {
    throw new Error('需要提供 projectDir 参数（项目目录路径）');
  }
  
  const projectDir = resolveInputPath(inputProjectDir);
  if (!fs.existsSync(projectDir)) {
    throw new Error(`项目目录不存在: ${projectDir}`);
  }
  
  const pomPath = path.join(projectDir, 'pom.xml');
  if (!fs.existsSync(pomPath)) {
    throw new Error(`项目目录中没有 pom.xml: ${projectDir}`);
  }
  
  const depsDir = args.depsDir ? resolveInputPath(args.depsDir) : path.join(projectDir, '.dtagent', 'deps');
  const settingsPath = resolveInputPath(args.settings || '~/.m2/settings.xml', projectDir);
  // Maven permits an absent default settings file, but not an absent explicit -s file.
  const settings = (args.settings || fs.existsSync(settingsPath)) ? settingsPath : undefined;
  const m2Repo = resolveMavenRepo(projectDir, args.m2Repo, m2Params, settings);
  console.log(`Maven 仓库: ${m2Repo}`);

  if (!fs.existsSync(depsDir)) {
    fs.mkdirSync(depsDir, { recursive: true });
  }
  
  console.log('从 pom 获取依赖版本...');
  const pomResult = await getDepsFromPom(projectDir, packages, m2Repo, m2Params, settings);

  if (pomResult.failed) {
    throw new Error(`mvn dependency:tree 执行失败: ${pomResult.error}`);
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
  const jarOutputDirs = new Set();
  let success = 0, skipped = 0, failed = 0;
  
  for (let i = 0; i < jars.length; i++) {
    const dep = jars[i];
    const classifierSuffix = dep.classifier ? `-${dep.classifier}` : '';
    const jarName = `${dep.artifactId}-${dep.version}${classifierSuffix}`;
    const jarOutputDir = path.join(depsDir, [
      dep.groupId, dep.artifactId, dep.version, dep.classifier || ''
    ].map(part => encodeURIComponent(part).replace(/\*/g, '%2A')).join('@'));
    
    console.log(`[${i + 1}/${jars.length}] 反编译 ${jarName}.jar...`);
    
    try {
      const versionsPath = path.join(depsDir, 'versions.json');
      let versions = {};
      if (fs.existsSync(versionsPath)) {
        versions = JSON.parse(fs.readFileSync(versionsPath, 'utf-8'));
      }
      
      const key = `${dep.groupId}:${dep.artifactId}:${dep.classifier || ''}`;
      const jarHash = dep.version.endsWith('-SNAPSHOT') ? await hashJar(dep.jarPath) : undefined;
      if (versions[key]?.version === dep.version && versions[key].jarPath === dep.jarPath &&
          versions[key].jarHash === jarHash &&
          fs.statSync(jarOutputDir, { throwIfNoEntry: false })?.isDirectory()) {
        console.log('  跳过 (缓存未变化)');
        skipped++;
        jarOutputDirs.add(jarOutputDir);
        continue;
      }
      
      fs.rmSync(jarOutputDir, { recursive: true, force: true });
      await decompileJar(dep.jarPath, jarOutputDir, cfrPath);
      
      versions[key] = {
        groupId: dep.groupId,
        artifactId: dep.artifactId,
        version: dep.version,
        jarPath: dep.jarPath,
        jarHash,
        decompiledAt: new Date().toISOString()
      };
      fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2));
      
      console.log(`  完成`);
      success++;
      jarOutputDirs.add(jarOutputDir);
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
  const index = generateIndex(depsDir, jarOutputDirs);
  const indexPath = path.join(depsDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`索引已更新，共 ${Object.keys(index).length} 个类`);
}

// 导出工具函数供 Skill 调用
module.exports = { main, getDepsFromPom, parseJarPath, generateIndex, parseDependencyTree, runMvnDependencyTree, parseMavenParams, resolveVariable };