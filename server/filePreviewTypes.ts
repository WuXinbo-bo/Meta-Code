export const CODE_PREVIEW_LANGUAGES: Readonly<Record<string, string>> = {
  ".py": "python",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ps1": "powershell",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".html": "xml",
  ".htm": "xml",
  ".xml": "xml",
  ".tex": "latex",
  ".bib": "latex",
  ".cls": "latex",
  ".json": "json",
  ".geojson": "json",
  ".jsonl": "json",
  ".drawio": "xml",
  ".sql": "sql"
};

export const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".txt", ".log", ".aux", ".toc", ".out", ".bbl", ".blg", ".bak",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".properties"
]);

export const BINARY_PREVIEW_EXTENSIONS = new Set([
  ".pyc", ".ttf", ".ttc", ".zip", ".7z", ".rar", ".gz", ".tar",
  ".exe", ".dll", ".so", ".dylib", ".wasm", ".bin"
]);

export function looksLikeTextPreview(buffer: Uint8Array) {
  if (!buffer.length) return true;
  if (buffer.includes(0)) return false;
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return false;
  }
  let controlCharacters = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) controlCharacters += 1;
  }
  return controlCharacters <= Math.max(2, Math.floor(text.length * 0.02));
}
