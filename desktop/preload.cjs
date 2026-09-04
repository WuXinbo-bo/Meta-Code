const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("metaCodeDesktop", {
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  restoreBackup(name) {
    return ipcRenderer.invoke("metacode:restore-backup", name);
  }
});
