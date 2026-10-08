import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const STORAGE_KEY = "metamodel.theme";

export function getThemePreference(): ThemePreference {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function resolveThemePreference(preference: ThemePreference): Theme {
  if (preference === "light" || preference === "dark") return preference;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function setThemePreference(preference: ThemePreference) {
  if (preference === "system") localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, preference);
  applyTheme(resolveThemePreference(preference));
}

export function getInitialTheme(): Theme {
  return resolveThemePreference(getThemePreference());
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  };

  return (
    <button
      type="button"
      className={`icon-button theme-toggle ${className}`.trim()}
      aria-label={theme === "dark" ? "切换到日间模式" : "切换到夜间模式"}
      title={theme === "dark" ? "日间模式" : "夜间模式"}
      onClick={toggle}
    >
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}

/** Persistent theme preference control for the settings page. */
export function ThemePreferenceControl() {
  const [preference, setPreference] = useState<ThemePreference>(() => getThemePreference());

  const update = (next: ThemePreference) => {
    setPreference(next);
    setThemePreference(next);
  };

  return <section className="page-settings-group theme-preference-settings">
    <header><Monitor size={17} /><div><strong>外观主题</strong><span>选择工作台的颜色主题；跟随系统会随 macOS 或 Windows 外观自动切换。</span></div></header>
    <div className="page-settings-row">
      <label htmlFor="theme-preference"><strong>颜色模式</strong><span>主题会立即应用并保存在本机，不影响任务与工作区数据。</span></label>
      <select id="theme-preference" value={preference} onChange={(event) => update(event.target.value as ThemePreference)}>
        <option value="system">跟随系统</option>
        <option value="light">日间模式</option>
        <option value="dark">夜间模式</option>
      </select>
    </div>
    <div className="theme-preference-hint" aria-live="polite">
      {preference === "dark" ? <Moon size={13} /> : preference === "light" ? <Sun size={13} /> : <Monitor size={13} />}
      <span>{preference === "system" ? `当前使用${resolveThemePreference(preference) === "dark" ? "夜间" : "日间"}主题` : preference === "dark" ? "当前使用夜间主题" : "当前使用日间主题"}</span>
    </div>
  </section>;
}
