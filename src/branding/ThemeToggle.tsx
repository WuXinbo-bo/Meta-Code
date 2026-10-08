import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const STORAGE_KEY = "metamodel.theme";
const THEME_CHANGED_EVENT = "metacode:theme-changed";
let memoryPreference: ThemePreference | undefined;

export function getThemePreference(): ThemePreference {
  if (memoryPreference !== undefined) return memoryPreference;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch { return "system"; }
}

export function resolveThemePreference(preference: ThemePreference): Theme {
  if (preference === "light" || preference === "dark") return preference;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
    memoryPreference = undefined;
  } catch { memoryPreference = preference; }
  applyTheme(resolveThemePreference(preference));
}

export function getInitialTheme(): Theme {
  return resolveThemePreference(getThemePreference());
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.dispatchEvent(new Event(THEME_CHANGED_EVENT));
}

export function startThemeSynchronization() {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const sync = () => applyTheme(getInitialTheme());
  const systemChanged = () => { if (getThemePreference() === "system") sync(); };
  const storageChanged = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    memoryPreference = undefined;
    sync();
  };
  media?.addEventListener("change", systemChanged);
  window.addEventListener("storage", storageChanged);
  sync();
  return () => {
    media?.removeEventListener("change", systemChanged);
    window.removeEventListener("storage", storageChanged);
  };
}

function useThemeState() {
  const read = () => ({ preference: getThemePreference(), theme: getInitialTheme() });
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    window.addEventListener(THEME_CHANGED_EVENT, update);
    update();
    return () => window.removeEventListener(THEME_CHANGED_EVENT, update);
  }, []);
  return state;
}

/** Persistent theme preference control for the settings page. */
export function ThemePreferenceControl() {
  const { preference, theme } = useThemeState();

  return <section className="page-settings-group theme-preference-settings">
    <header><Monitor size={17} /><div><strong>外观主题</strong><span>选择工作台的颜色主题；跟随系统会随 macOS 或 Windows 外观自动切换。</span></div></header>
    <div className="page-settings-row">
      <label htmlFor="theme-preference"><strong>颜色模式</strong><span>主题会立即应用并保存在本机，不影响任务与工作区数据。</span></label>
      <select id="theme-preference" value={preference} onChange={(event) => setThemePreference(event.target.value as ThemePreference)}>
        <option value="system">跟随系统</option>
        <option value="light">日间模式</option>
        <option value="dark">夜间模式</option>
      </select>
    </div>
    <div className="theme-preference-hint" aria-live="polite">
      {preference === "dark" ? <Moon size={13} /> : preference === "light" ? <Sun size={13} /> : <Monitor size={13} />}
      <span>当前使用{theme === "dark" ? "夜间" : "日间"}主题</span>
    </div>
  </section>;
}
