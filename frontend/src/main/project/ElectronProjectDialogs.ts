import { dialog, type BrowserWindow } from "electron";
import type { ProjectDialogPort, RecoveryDecision, UnsavedDecision } from "./ProjectController.js";
import type { RecoveryCandidate } from "./ProjectFileService.js";

const PROJECT_FILTER = [{ name: "Projeto P7M", extensions: ["json"] }];

export class ElectronProjectDialogs implements ProjectDialogPort {
  constructor(private readonly getWindow: () => BrowserWindow) {}

  async chooseProjectFile(): Promise<string | undefined> {
    const result = await dialog.showOpenDialog(this.getWindow(), {
      title: "Abrir projeto P7M",
      filters: PROJECT_FILTER,
      properties: ["openFile"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  }

  async chooseProjectDirectory(projectName: string): Promise<string | undefined> {
    const result = await dialog.showOpenDialog(this.getWindow(), {
      title: `Escolha onde criar “${projectName}”`,
      buttonLabel: "Criar nesta pasta",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  }

  async chooseSavePath(suggestedName: string): Promise<string | undefined> {
    const result = await dialog.showSaveDialog(this.getWindow(), {
      title: "Salvar projeto P7M",
      filters: PROJECT_FILTER,
      defaultPath: `${safeStem(suggestedName)}.p7m.json`,
    });
    if (result.canceled || !result.filePath) return undefined;
    // O caminho retornado é exatamente aquele cuja eventual substituição o
    // diálogo nativo confirmou. Alterá-lo depois (por exemplo removendo uma
    // extensão digitada) poderia gravar sobre outro arquivo sem confirmação.
    return result.filePath;
  }

  async confirmUnsavedChanges(projectName: string): Promise<UnsavedDecision> {
    const result = await dialog.showMessageBox(this.getWindow(), {
      type: "warning",
      title: "Alterações não salvas",
      message: `“${projectName}” tem alterações não salvas.`,
      detail: "Salvar antes de continuar?",
      buttons: ["Salvar", "Descartar", "Cancelar"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return (["save", "discard", "cancel"] as const)[result.response] ?? "cancel";
  }

  async chooseRecovery(candidate: RecoveryCandidate): Promise<RecoveryDecision> {
    const timestamp = new Date(candidate.autosaveModifiedAtMs).toLocaleString("pt-BR");
    const result = await dialog.showMessageBox(this.getWindow(), {
      type: "question",
      title: "Recuperação disponível",
      message: "Existe uma recuperação mais recente para este projeto.",
      detail:
        `Autosave de ${timestamp}. Restaurar abre o conteúdo no arquivo original; ` +
        "Abrir cópia mantém o original intocado; Ignorar descarta a recuperação e abre o arquivo salvo.",
      buttons: ["Restaurar", "Abrir cópia", "Ignorar", "Cancelar"],
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    });
    return (["restore", "copy", "ignore", "cancel"] as const)[result.response] ?? "cancel";
  }
}

function safeStem(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/g, "-").replace(/[. ]+$/g, "") || "projeto";
}
