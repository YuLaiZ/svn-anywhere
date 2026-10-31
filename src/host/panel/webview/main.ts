/**
 * Webview 入口（打包为 media/panel.js，iife）。只做环境胶水：
 * 获取 acquireVsCodeApi、挂载应用、桥接 window message 事件。
 * 业务判断与用户文案都不出现在这里（见 app.ts 头注释）。
 */
import { mountPanel } from './app';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState?(): unknown;
  setState?(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();
const app = mountPanel(document, api);

window.addEventListener('message', (event: MessageEvent) => {
  app.handleHostMessage(event.data);
});
