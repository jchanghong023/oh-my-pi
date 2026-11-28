/**
 * Extract Maven Configuration Script
 * 提取 Maven 配置并直接输出 JSON 格式
 */

const fs = require('fs');
const path = require('path');

function decodeXmlAttribute(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity) =>
    entity[0] === '#'
      ? String.fromCodePoint(Number(entity[1] === 'x' ? `0${entity.slice(1)}` : entity.slice(1)))
      : entities[entity]
  );
}

function extractMavenConfig(projectDir) {
  const config = {};
  let workspacePath;
  for (let dir = path.resolve(projectDir); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, '.idea', 'workspace.xml');
    if (fs.existsSync(candidate)) {
      workspacePath = candidate;
      break;
    }
    if (path.dirname(dir) === dir) break;
  }

  if (workspacePath) {
    try {
      const content = fs.readFileSync(workspacePath, 'utf-8');
      
      const settingsMatch = content.match(/userSettingsFile[^>]*value="([^"]+)"/);
      if (settingsMatch) {
        config.settingsPath = decodeXmlAttribute(settingsMatch[1]);
      }

      const mavenProperties = extractMavenProperties(content);
      const vmOptions = extractVmOptions(content);

      if (mavenProperties.length) {
        config.mavenProperties = mavenProperties;
      }
      if (vmOptions) {
        config.vmOptions = vmOptions;
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
      const key = decodeXmlAttribute(entryMatch[1]);
      const value = decodeXmlAttribute(entryMatch[2]);
      properties.push(`-D${key}=${value}`);
    }
  }

  return properties;
}

function extractVmOptions(content) {
  // 匹配 MavenRunner 组件中的 vmOptions 配置
  const runner = /<component\s+name="MavenRunner"\s*>([\s\S]*?)<\/component>/.exec(content);
  if (!runner) return '';
  const option = /<option name="vmOptions" value="([^"]*)"\s*\/>/.exec(runner[1]);
  return option ? decodeXmlAttribute(option[1]) : '';
}

function findProjectDir(startDir) {
  let currentDir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(currentDir, 'pom.xml'))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
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