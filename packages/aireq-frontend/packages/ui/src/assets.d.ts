declare module "*.css";
declare module "*.mp3";
declare module "*.png";
declare module "*.svg";
declare module "*.webp";

// 原型编辑器的静态 Markdown 样例，由 Vite 按文本加载。
declare module "*.md?raw" {
  const text: string;
  export default text;
}

// Vite 的 `?url` 资源导入（如 pdf.js worker），返回打包后的资源 URL 字符串。
declare module "*?url" {
  const src: string;
  export default src;
}
