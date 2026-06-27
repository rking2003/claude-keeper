import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type SessionStartConfig, type SessionWireEvent, type KeeperSettings, type SettingsSaveResult, type RendererLogPayload } from '../shared/ipc';

const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  settings: {
    load: (): Promise<KeeperSettings> => ipcRenderer.invoke(IPC.settingsLoad),
    save: (s: KeeperSettings): Promise<SettingsSaveResult> => ipcRenderer.invoke(IPC.settingsSave, s),
  },
  session: {
    start: (cfg: SessionStartConfig): Promise<{ ok: true }> =>
      ipcRenderer.invoke(IPC.sessionStart, cfg),
    write: (data: string): void => ipcRenderer.send(IPC.sessionWrite, data),
    resize: (cols: number, rows: number): void =>
      ipcRenderer.send(IPC.sessionResize, { cols, rows }),
    stop: (): Promise<{ ok: true }> => ipcRenderer.invoke(IPC.sessionStop),
    resumeNow: (): void => ipcRenderer.send(IPC.sessionResumeNow),
    resumeAfter: (delayMs: number): void => ipcRenderer.send(IPC.sessionResumeAfter, delayMs),
    setAutoResume: (enabled: boolean): void =>
      ipcRenderer.send(IPC.sessionSetAutoResume, enabled),
    setReplayPrompt: (text: string): void =>
      ipcRenderer.send(IPC.sessionSetReplayPrompt, text),
    ready: (): Promise<{ recovered: boolean }> => ipcRenderer.invoke(IPC.sessionReady),
    onEvent: (cb: (ev: SessionWireEvent) => void): (() => void) => {
      const listener = (_e: unknown, ev: SessionWireEvent): void => cb(ev);
      ipcRenderer.on(IPC.sessionEvent, listener);
      return () => ipcRenderer.removeListener(IPC.sessionEvent, listener);
    },
  },
  logs: {
    /** Open the on-disk log file in the OS default handler. */
    open: (): Promise<{ path: string }> => ipcRenderer.invoke(IPC.logsOpen),
  },
  diag: {
    /** Forward a diagnostic line from the renderer into the main-process log. */
    log: (payload: RendererLogPayload): void => ipcRenderer.send(IPC.logWrite, payload),
  },
};

export type KeeperApi = typeof api;

contextBridge.exposeInMainWorld('keeper', api);
