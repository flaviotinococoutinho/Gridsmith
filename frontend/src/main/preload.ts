/**
 * Preload: expõe a API do editor ao renderer com contextIsolation.
 * O renderer nunca vê Node/rede — só esta superfície tipada.
 */

import { contextBridge, ipcRenderer } from "electron";

export interface P7mEditorApi {
  connect(): Promise<{ sessionId: string }>;
  dispatch(kind: string, payload: Record<string, unknown>): Promise<unknown>;
  query(projection: string): Promise<unknown>;
  experience(family?: string, version?: string): Promise<unknown>;
  onBlueprintEvent(listener: (event: { kind: string }) => void): void;
}

const api: P7mEditorApi = {
  connect: () => ipcRenderer.invoke("p7m:connect"),
  dispatch: (kind, payload) => ipcRenderer.invoke("p7m:dispatch", kind, payload),
  query: (projection) => ipcRenderer.invoke("p7m:query", projection),
  experience: (family, version) => ipcRenderer.invoke("p7m:experience", family, version),
  onBlueprintEvent: (listener) => {
    ipcRenderer.on("p7m:blueprint-event", (_event, payload) => listener(payload));
  },
};

contextBridge.exposeInMainWorld("p7m", api);
