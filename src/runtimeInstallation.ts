export type InstallationRuntime = {
  available: boolean;
  npmAvailable?: boolean;
  installation?: { supported: boolean; environment: "ready" | "preparable" | "unsupported"; requiresNpm: boolean };
  managed?: { installed: boolean; healthy?: boolean };
};

export function runtimeInstallationAction(runtime: InstallationRuntime | undefined) {
  const supported = runtime?.installation?.supported !== false;
  const repair = Boolean(runtime?.managed?.installed && runtime.managed.healthy === false);
  return {
    supported,
    repair,
    label: repair ? "重新安装修复" : "安装到工作台",
    environmentMessage: runtime?.installation?.environment === "preparable" ? "安装时会自动准备必要环境" : ""
  };
}
