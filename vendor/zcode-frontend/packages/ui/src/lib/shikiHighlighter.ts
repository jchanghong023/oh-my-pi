import type { BundledTheme, HighlighterCore, LanguageRegistration, ThemedToken } from "shiki";
import { createHighlighterCore } from "shiki/core";
import type { ThemeRegistrationAny } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { logger } from "@/logger.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

// WebGUI 需要跑在窄带的移动中继上（~3 MB/s），Shiki 的全量语言包（~19 MB）是
// 首屏和更新的最大负担。这里只保留聊天/工具卡片里真正会出现的 17 种语言，
// 每种语言一个动态 import，未列出的语言一律走 raw tokens。
const LANGUAGE_LOADERS = {
  bash: () => import("shiki/langs/bash.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
} satisfies Record<string, () => Promise<{ default: LanguageRegistration[] }>>;

type CodeLanguage = keyof typeof LANGUAGE_LOADERS;

const LANGUAGE_ALIASES = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  js: "javascript",
  ts: "typescript",
  py: "python",
  md: "markdown",
  yml: "yaml",
} satisfies Record<string, CodeLanguage>;

// 设置页可选的代码主题（见 codePreviewPreferences.CODE_PREVIEW_THEME_OPTIONS）。
// 主题同样按需加载，避免带入 Shiki 的全量主题包。
const THEME_LOADERS = {
  "github-light": () => import("shiki/themes/github-light.mjs"),
  "github-dark": () => import("shiki/themes/github-dark.mjs"),
  "vitesse-light": () => import("shiki/themes/vitesse-light.mjs"),
  "vitesse-dark": () => import("shiki/themes/vitesse-dark.mjs"),
  "min-light": () => import("shiki/themes/min-light.mjs"),
  "min-dark": () => import("shiki/themes/min-dark.mjs"),
  "github-light-high-contrast": () => import("shiki/themes/github-light-high-contrast.mjs"),
  "github-dark-high-contrast": () => import("shiki/themes/github-dark-high-contrast.mjs"),
  "catppuccin-latte": () => import("shiki/themes/catppuccin-latte.mjs"),
  "catppuccin-mocha": () => import("shiki/themes/catppuccin-mocha.mjs"),
} satisfies Record<string, () => Promise<{ default: ThemeRegistrationAny }>>;

type CodeTheme = keyof typeof THEME_LOADERS;

const PLAIN_TEXT_CODE_LANGUAGES = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "log",
  "output",
]);

const isCodeLanguage = (language: string): language is CodeLanguage =>
  Object.hasOwn(LANGUAGE_LOADERS, language);

export function shouldUseSyntaxHighlighting(language: string): boolean {
  const candidate = language.trim().toLowerCase();
  if (PLAIN_TEXT_CODE_LANGUAGES.has(candidate)) {
    return false;
  }

  return isCodeLanguage(candidate) || Object.hasOwn(LANGUAGE_ALIASES, candidate);
}

function normalizeCodeLanguage(language: string): CodeLanguage | null {
  const candidate = language.trim().toLowerCase();
  if (isCodeLanguage(candidate)) {
    return candidate;
  }

  const alias = Object.hasOwn(LANGUAGE_ALIASES, candidate)
    ? LANGUAGE_ALIASES[candidate as keyof typeof LANGUAGE_ALIASES]
    : null;
  return alias ?? null;
}

const highlighterCache = new Map<string, Promise<HighlighterCore>>();
const tokensCache = new Map<string, TokenizedCode>();
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();
// 内存诊断计数器：tokensCache 目前无淘汰，是审计里
// renderer 最可疑的增长点，先把条数落到日志里。
uiMemoryDiagnosticsRegistry.register("shiki", () => ({
  tokensCache: tokensCache.size,
  highlighters: highlighterCache.size,
}));

const prefersDarkDocument = () =>
  typeof document !== "undefined" && document.documentElement.classList.contains("dark");

const isCodeTheme = (theme: string): theme is CodeTheme => Object.hasOwn(THEME_LOADERS, theme);

const getResolvedCodeTheme = (theme?: BundledTheme): CodeTheme => {
  if (theme && isCodeTheme(theme)) {
    return theme;
  }

  return prefersDarkDocument() ? "github-dark" : "github-light";
};

const getCodeTokensCacheKey = (code: string, language: CodeLanguage, theme: CodeTheme) => {
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : "";
  return `${theme}:${language}:${code.length}:${start}:${end}`;
};

let enginePromise: ReturnType<typeof createOnigurumaEngine> | undefined;
const getEngine = () => (enginePromise ??= createOnigurumaEngine(import("shiki/wasm")));

const getHighlighter = (language: CodeLanguage, theme: CodeTheme): Promise<HighlighterCore> => {
  const cacheKey = `${theme}:${language}`;
  const cached = highlighterCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const highlighterPromise = (async () => {
    const [languageModule, themeModule, engine] = await Promise.all([
      LANGUAGE_LOADERS[language](),
      THEME_LOADERS[theme](),
      getEngine(),
    ]);

    // 显式传入注册表，避免 createHighlighter 的 bundledLanguages 把全部语言打进产物。
    return createHighlighterCore({
      langs: languageModule.default,
      themes: [themeModule.default],
      engine,
    });
  })();

  highlighterCache.set(cacheKey, highlighterPromise);
  return highlighterPromise;
};

export const createRawCodeTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ],
  ),
});

// 带缓存的异步高亮入口；React 组件只应在 effect 中调用。
export const highlightCode = (
  code: string,
  language: string,
  theme?: BundledTheme,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  const resolvedLanguage = normalizeCodeLanguage(language);
  if (!shouldUseSyntaxHighlighting(language) || !resolvedLanguage) {
    // 文本/日志代码块没有语法高亮收益，却会在聊天流式渲染和历史恢复时进入
    // Shiki 的异步状态机。之前修掉了 render 阶段 setState，但这条纯文本路径仍可能把
    // CodeViewer 拖进 React #185；这里直接返回 raw tokens，避免启动高亮副作用。
    return createRawCodeTokens(code);
  }

  const resolvedTheme = getResolvedCodeTheme(theme);
  const tokensCacheKey = getCodeTokensCacheKey(code, resolvedLanguage, resolvedTheme);

  const cached = tokensCache.get(tokensCacheKey);
  if (cached) {
    // 缓存命中时也需要通知 effect，但不能同步触发 setState。
    // 历史消息恢复时大量代码块会在同一次提交后挂载；同步 callback 会把 cache-hit 变成嵌套更新，
    // 和 Streamdown 的重渲染叠在一起时容易触发 React #185。推迟到微任务后再交给幂等 setter。
    if (callback) {
      queueMicrotask(() => callback(cached));
    }
    return cached;
  }

  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }
    subscribers.get(tokensCacheKey)?.add(callback);
  }

  getHighlighter(resolvedLanguage, resolvedTheme)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const result = highlighter.codeToTokens(code, {
        lang: resolvedLanguage,
        theme: resolvedTheme,
      });

      const tokenized: TokenizedCode = {
        bg: "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      tokensCache.set(tokensCacheKey, tokenized);

      const subs = subscribers.get(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(tokenized);
        }
      }
      subscribers.delete(tokensCacheKey);
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      // Shiki 加载或 tokenize 失败，组件会停留在无高亮的 rawTokens 状态。
      logger.error(
        `[ShikiHighlighter] 代码高亮失败: language=${resolvedLanguage}, theme=${resolvedTheme}`,
        error,
      );
      subscribers.delete(tokensCacheKey);
    });

  return null;
};
