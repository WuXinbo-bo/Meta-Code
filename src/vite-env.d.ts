/// <reference types="vite/client" />

interface Window {
  metaCodeDesktop?: {
    getPathForFile(file: File): string;
  };
}
