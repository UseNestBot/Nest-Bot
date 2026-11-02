import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS, IPC_EVENT_CHANNEL, type NestApi } from '@shared/ipc';
import type { NestEvent } from '@shared/types';

// Each API method maps to exactly one ipcMain handler; nothing else from Node is exposed.
const api = Object.fromEntries(
  API_METHODS.map((method) => [
    method,
    async (...args: unknown[]) => {
      const res = (await ipcRenderer.invoke(`nest:${method}`, ...args)) as { ok: true; value: unknown } | { ok: false; error: string };
      if (!res.ok) throw new Error(res.error);
      return res.value;
    },
  ]),
) as unknown as Omit<NestApi, 'onEvent'>;

const nest: NestApi = {
  ...api,
  onEvent(listener) {
    const handler = (_: Electron.IpcRendererEvent, event: NestEvent) => listener(event);
    ipcRenderer.on(IPC_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IPC_EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld('nest', nest);
