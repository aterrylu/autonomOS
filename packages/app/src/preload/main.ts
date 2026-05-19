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
    setDefault: (id: string | null): Promise<void> =>
      ipcRenderer.invoke(IPC.CONNECTIONS_SET_DEFAULT, id),
    getDefault: (): Promise<string | null> =>
      ipcRenderer.invoke("connections:get-default"),
  },
  localServer: {
    status: (): Promise<LocalServerStatus> =>
      ipcRenderer.invoke(IPC.LOCAL_SERVER_STATUS),
  },
  encryption: {
    isAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke("encryption:is-available"),
  },
};

contextBridge.exposeInMainWorld("autonomos", api);
