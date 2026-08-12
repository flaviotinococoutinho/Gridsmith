/**
 * Registro de comandos do workbench (E10).
 *
 * Todo verbo da interface — desfazer, refazer, publicar, trocar de painel —
 * passa a ser um comando com id, rótulo, governança e (opcionalmente) atalho.
 * Menu nativo, barra de ferramentas e teclado deixam de ser três caminhos
 * paralelos para a mesma ação: os três resolvem o MESMO comando.
 *
 * Módulo puro (regra F1): o handler é injetado pela casca.
 */

import type { CapabilityRegistry } from "./capabilityRegistry.js";
import { ContributionRegistry, type Contribution } from "./contributions.js";
import { chordFromStroke, chordKey, formatChord, parseChord, type Chord, type KeyStroke } from "./keybindings.js";

export interface CommandContribution extends Contribution {
  /** Agrupamento humano para o menu/paleta ("Editar", "Projeto", "Nível"). */
  readonly category: string;
  /** Acordes que disparam o comando; podem ser vários (Ctrl+Shift+Z e Ctrl+Y). */
  readonly keybindings?: readonly string[];
  /** O que o comando faz. Pode ser assíncrono; a casca trata a rejeição. */
  readonly run: () => void | Promise<void>;
}

export class KeybindingConflictError extends Error {
  constructor(chord: string, owner: string, intruder: string) {
    super(`o atalho ${chord} já pertence ao comando "${owner}"; "${intruder}" não pode reivindicá-lo`);
    this.name = "KeybindingConflictError";
  }
}

/**
 * Executar comando desabilitado é ERRO com a razão da governança dentro — não
 * um no-op. Um botão que não faz nada e não diz por quê é a forma mais cara de
 * esconder uma decisão de perfil do usuário.
 */
export class CommandDisabledError extends Error {
  constructor(
    readonly commandId: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "CommandDisabledError";
  }
}

export class UnknownCommandError extends Error {
  constructor(commandId: string) {
    super(`comando desconhecido "${commandId}"`);
    this.name = "UnknownCommandError";
  }
}

export interface ResolvedCommand {
  readonly command: CommandContribution;
  readonly enabled: boolean;
  readonly reason?: string;
  /** Atalho já formatado para exibição ("Ctrl+Shift+Z"); ausente sem atalho. */
  readonly shortcut?: string;
}

export class CommandRegistry extends ContributionRegistry<CommandContribution> {
  /** chave do acorde → id do comando. Um acorde tem UM dono. */
  private readonly chords = new Map<string, string>();

  constructor() {
    super("comando");
  }

  override register(command: CommandContribution): CommandContribution {
    // valida os acordes ANTES de inserir: um comando com atalho conflitante
    // não pode ficar meio-registrado
    const parsed = (command.keybindings ?? []).map((text) => parseChord(text));
    for (const chord of parsed) {
      const owner = this.chords.get(chordKey(chord));
      if (owner !== undefined && owner !== command.id) {
        throw new KeybindingConflictError(formatChord(chord), owner, command.id);
      }
    }
    super.register(command);
    for (const chord of parsed) this.chords.set(chordKey(chord), command.id);
    return command;
  }

  /** Devolve o comando E os acordes que ele reivindicava — um painel desmontado libera o Ctrl+Z. */
  override unregister(id: string): boolean {
    const removed = super.unregister(id);
    if (removed) {
      for (const [chord, owner] of this.chords) {
        if (owner === id) this.chords.delete(chord);
      }
    }
    return removed;
  }

  /** Comando dono de um acorde, independentemente de estar habilitado. */
  commandForChord(chord: Chord): CommandContribution | undefined {
    const id = this.chords.get(chordKey(chord));
    return id === undefined ? undefined : this.get(id);
  }

  /** Comando disparado por uma tecla — o único caminho do teclado para a ação. */
  commandForStroke(stroke: KeyStroke): CommandContribution | undefined {
    return this.commandForChord(chordFromStroke(stroke));
  }

  resolve(commandId: string, capabilities: CapabilityRegistry): ResolvedCommand | undefined {
    const command = this.get(commandId);
    if (!command) return undefined;
    const answer = capabilities.resolve(command);
    const first = command.keybindings?.[0];
    return {
      command,
      enabled: answer.enabled,
      ...(answer.enabled ? {} : { reason: answer.reason }),
      ...(first === undefined ? {} : { shortcut: formatChord(parseChord(first)) }),
    };
  }

  /** Todos os comandos resolvidos — alimenta menu e paleta sem duplicar regra. */
  resolveAll(capabilities: CapabilityRegistry): ResolvedCommand[] {
    return this.all().map((command) => this.resolve(command.id, capabilities)!);
  }

  /**
   * Executa pelo id. Devolve a promessa do handler para que a casca reporte a
   * falha ao usuário em vez de deixá-la virar unhandled rejection.
   */
  async execute(commandId: string, capabilities: CapabilityRegistry): Promise<void> {
    const command = this.get(commandId);
    if (!command) throw new UnknownCommandError(commandId);
    const answer = capabilities.resolve(command);
    if (!answer.enabled) throw new CommandDisabledError(commandId, answer.reason);
    await command.run();
  }
}
