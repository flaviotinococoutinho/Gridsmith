/**
 * Shell do renderer: conecta via preload, resolve a experiência governada e
 * materializa a régua de painéis a partir do ExperienceGate — painéis
 * desabilitados mostram a RAZÃO vinda do perfil/manifesto (governança
 * visível, nunca um genérico "indisponível").
 */

import { ExperienceGate, type ResolvedExperienceLike } from "../core/experienceGate.js";
import type { P7mEditorApi } from "../main/preload.js";

declare global {
  interface Window {
    p7m: P7mEditorApi;
  }
}

const statusEl = document.getElementById("status")!;
const railEl = document.getElementById("panel-rail")!;
const runtimeEl = document.getElementById("runtime-label")!;
const logEl = document.getElementById("event-log")!;

function renderPanels(gate: ExperienceGate): void {
  railEl.replaceChildren();
  for (const [panelId, answer] of Object.entries(gate.allPanels())) {
    const chip = document.createElement("div");
    chip.className = `panel-chip ${answer.enabled ? "enabled" : "disabled"}`;
    chip.textContent = panelId;
    if (!answer.enabled) {
      const reason = document.createElement("span");
      reason.className = "reason";
      reason.textContent = answer.reason;
      chip.append(reason);
    }
    railEl.append(chip);
  }
}

function appendEvent(kind: string): void {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} — ${kind}`;
  logEl.prepend(item);
  while (logEl.children.length > 100) {
    logEl.lastChild?.remove();
  }
}

async function boot(): Promise<void> {
  try {
    const { sessionId } = await window.p7m.connect();
    statusEl.textContent = `Sessão de edição ${sessionId} estabelecida.`;

    const experience = (await window.p7m.experience()) as ResolvedExperienceLike;
    const gate = new ExperienceGate(experience);
    runtimeEl.textContent = gate.runtimeLabel;
    renderPanels(gate);

    window.p7m.onBlueprintEvent((event) => appendEvent(event.kind));
  } catch (err) {
    statusEl.textContent = `Falha ao conectar ao middleware: ${err instanceof Error ? err.message : err}`;
  }
}

void boot();
