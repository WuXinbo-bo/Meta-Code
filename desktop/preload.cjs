const { contextBridge, webUtils } = require("electron");

contextBridge.exposeInMainWorld("metaCodeDesktop", {
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  }
});
