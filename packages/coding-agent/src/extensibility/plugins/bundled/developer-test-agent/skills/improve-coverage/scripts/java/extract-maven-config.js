/**
 * Extract Maven Configuration Script
 * 提取 Maven 配置并直接输出 JSON 格式
 */

const fs = require('fs');
const path = require('path');

function extractMavenConfig(projectDir) {
  const config = {};
  const workspacePath = path.join(projectDir, '.idea', 'workspace.xml');

  if (fs.existsSync(workspacePath)) {
    try {
      const content = fs.readFileSync(workspacePath, 'utf-8');
      
      const settingsMatch = content.match(/userSettingsFile[^>]*value="([^"]+)"/);
      if (settingsMatch) {
        config.settingsPath = settingsMatch[1];
      }

      const mavenProperties = extractMavenProperties(content);
      const vmOptions = extractVmOptions(content);

      // 将 vmOptions 合并到 mavenProperties 中
      const allProperties = [mavenProperties, vmOptions].filter(p => p).join(' ');
      if (allProperties) {
        config.mavenProperties = allProperties;
      }
    } catch (e) {
      // 提取失败，输出空 JSON
      console.log('{}');
      return {};
    }
  } else {
    // workspace.xml 不存在，输出空 JSON
    console.log('{}');
    return {};
  }

  // 直接输出 JSON，不写入文件
  console.log(JSON.stringify(config));
  return config;
}

function extractMavenProperties(content) {
  const properties = [];
  const mapPattern = /<option name="mavenProperties">\s*<map>([\s\S]*?)<\/map>\s*<\/option>/g;
  let match;

  while ((match = mapPattern.exec(content)) !== null) {
    const mapContent = match[1];
    const entryPattern = /<entry key="([^"]*)" value="([^"]*)"\s*\/>/g;
    let entryMatch;

    while ((entryMatch = entryPattern.exec(mapContent)) !== null) {
      const key = entryMatch[1];
      const value = entryMatch[2];
      properties.push(`-D${key}=${value}`);
    }
  }

  return properties.length > 0 ? properties.join(' ') : '';
}

function extractVmOptions(content) {
  // 匹配 MavenRunner 组件中的 vmOptions 配置
  const vmOptionsPattern = /<component name="MavenRunner">[\s\S]*?<option name="vmOptions" value="([^"]*)"\s*\/>/g;
  let match;
  const vmOptions = [];

  while ((match = vmOptionsPattern.exec(content)) !== null) {
    const value = match[1];
    if (value) {
      vmOptions.push(value);
    }
  }

  return vmOptions.length > 0 ? vmOptions.join(' ') : '';
}

function findProjectDir(startDir) {
  let currentDir = startDir;
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, 'pom.xml'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  return null;
}

async function main(options = {}) {
  const cliArg = process.argv[2];
  const startDir = cliArg || options.projectDir;

  if (!startDir) {
    console.error('Usage: node extract-maven-config.js <projectDir>');
    console.log('{}');
    return { success: false, config: {} };
  }

  const projectDir = findProjectDir(startDir);

  if (!projectDir) {
    console.log('{}');
    return { success: false, config: {} };
  }

  const config = extractMavenConfig(projectDir);
  return { success: true, projectDir, config };
}

if (require.main === module) {
  main().catch(e => {
    console.log('{}');
  });
}

module.exports = { main, extractMavenConfig };