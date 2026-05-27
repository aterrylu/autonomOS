// Preload bridge exposed to the renderer process. All renderer-facing IPC
// goes through here; the renderer never touches `electron` directly.

import { contextBridge, ipcRenderer } from "electron";

import type {
  AddConnectionInput,
  AddConnectionResult,
  AutonomosAPI,
  LocalServerStatus,
} from "../shared/api.js";
import { IPC } from "../shared/constants.js";
import type { Connection } from "../types/connection.js";

const api: AutonomosAPI = {
  version: 1,
  connections: {
    list: (): Promise<Connection[]> => ipcRenderer.invoke(IPC.CONNECTIONS_LIST),
    add: (input: AddConnectionInput): Promise<AddConnectionResult> =>
      ipcRenderer.invoke(IPC.CONNECTIONS_ADD, input),
    remove: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC.CONNECTIONS_REMOVE, id),
  },
  localServer: {
    status: (): Promise<LocalServerStatus> =>
      ipcRenderer.invoke(IPC.LOCAL_SERVER_STATUS),
    info: () => ipcRenderer.invoke("local-server:info"),
    detect: () => ipcRenderer.invoke("local-server:detect"),
    acquire: () => ipcRenderer.invoke("local-server:acquire"),
    migrateToAlwaysOn: () =>
      ipcRenderer.invoke("local-server:migrate-to-always-on"),
    migrateToBuiltIn: () =>
      ipcRenderer.invoke("local-server:migrate-to-built-in"),
  },
  encryption: {
    isAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke("encryption:is-available"),
  },
  webview: {
    prepare: (id: string) =>
      ipcRenderer.invoke("connections:prepare-webview", id),
  },
  windows: {
    openConnection: (id: string): Promise<void> =>
      ipcRenderer.invoke("windows:open-connection", id),
    newWelcome: (): Promise<void> => ipcRenderer.invoke("windows:new-welcome"),
    closeSelf: (): Promise<void> => ipcRenderer.invoke("windows:close-self"),
    dragStart: (): void => {
      ipcRenderer.send("windows:drag-start");
    },
    dragEnd: (): void => {
      ipcRenderer.send("windows:drag-end");
    },
  },
};

contextBridge.exposeInMainWorld("autonomos", api);
