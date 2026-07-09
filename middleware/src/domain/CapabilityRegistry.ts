/**
 * Registro de capacidades da engine.
 *
 * A cada sessão nova o registro pede `engine/describe` e cacheia o manifesto:
 * limites reais do núcleo DOD, layouts binários derivados por reflexão e os
 * ganchos de edição de cada subsistema. É o "proxy de possibilidades" entre a
 * engine MonoGame e o editor visual — a UI do Electron materializa painéis,
 * gizmos e tipos de nó a partir de <see>editorConcepts()</see> em vez de
 * hardcodar o que a engine sabe fazer.
 */

import { EventEmitter } from "node:events";
import type { EnginePipeServer, EngineSession } from "../ipc/EnginePipeServer.js";
import type { VertexLayout } from "../sharedmem/vertexLayout.js";

export interface EngineIdentity {
  name: string;
  version: string;
  protocolVersion: string;
  /** Identidade do runtime hospedeiro — alimenta a resolução de perfil. */
  runtime?: { family: string; version: string };
}

export interface EditorPropertyHint {
  name: string;
  type: "float" | "int" | "bool" | "enum" | "curve" | "color";
  min?: number;
  max?: number;
  default?: unknown;
  options?: string[];
}

export interface EditorHints {
  panel?: string;
  gizmos?: string[];
  nodeTypes?: string[];
  properties?: EditorPropertyHint[];
}

export interface SubsystemManifest {
  status: "available" | "planned";
  phase?: number;
  limits?: Record<string, number>;
  features?: string[];
  vertexLayouts?: VertexLayout[];
  editor?: EditorHints;
}

export interface EngineManifest {
  engine: EngineIdentity;
  subsystems: Record<string, SubsystemManifest>;
}

/** Projeção orientada ao editor: um conceito visual por subsistema. */
export interface EditorConcept {
  subsystem: string;
  status: "available" | "planned";
  phase?: number;
  panel?: string;
  gizmos: string[];
  nodeTypes: string[];
  properties: EditorPropertyHint[];
  limits: Record<string, number>;
  features: string[];
}

/**
 * Eventos:
 * - "capabilities" (manifest: EngineManifest) — manifesto novo cacheado
 * - "describeError" (err: Error) — describe falhou (sessão segue utilizável)
 */
export class CapabilityRegistry extends EventEmitter {
  private current: EngineManifest | undefined;

  constructor(server: EnginePipeServer) {
    super();
    server.on("session", (session: EngineSession) => {
      void this.refresh(session);
    });
  }

  get manifest(): EngineManifest | undefined {
    return this.current;
  }

  /** Aguarda um manifesto estar disponível (sessão já descrita ou próxima). */
  async waitForManifest(timeoutMs = 10_000): Promise<EngineManifest> {
    if (this.current) return this.current;
    return new Promise<EngineManifest>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No engine manifest received within ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
      this.once("capabilities", (manifest: EngineManifest) => {
        clearTimeout(timer);
        resolve(manifest);
      });
    });
  }

  /** Layout binário publicado pela engine (fonte de verdade dos offsets). */
  findVertexLayout(name: string): VertexLayout | undefined {
    for (const subsystem of Object.values(this.current?.subsystems ?? {})) {
      const found = subsystem.vertexLayouts?.find((l) => l.name === name);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Conceitos de edição visual: o cardápio que o editor Electron usa para
   * montar painéis, paletas de nós e gizmos — incluindo o que ainda é
   * "planned" (a UI pode exibir como preview desabilitado com a fase prevista).
   */
  editorConcepts(): EditorConcept[] {
    const manifest = this.current;
    if (!manifest) return [];
    return Object.entries(manifest.subsystems).map(([subsystem, m]) => ({
      subsystem,
      status: m.status,
      ...(m.phase !== undefined ? { phase: m.phase } : {}),
      ...(m.editor?.panel !== undefined ? { panel: m.editor.panel } : {}),
      gizmos: m.editor?.gizmos ?? [],
      nodeTypes: m.editor?.nodeTypes ?? [],
      properties: m.editor?.properties ?? [],
      limits: m.limits ?? {},
      features: m.features ?? [],
    }));
  }

  private async refresh(session: EngineSession): Promise<void> {
    try {
      const manifest = await session.peer.request<EngineManifest>("engine/describe");
      this.current = manifest;
      this.emit("capabilities", manifest);
    } catch (err) {
      this.emit("describeError", err instanceof Error ? err : new Error(String(err)));
    }
  }
}
