/**
 * A categoria é prefixada pelo EditorClient porque Electron preserva a
 * mensagem de Error no IPC, mas não garante propriedades customizadas.
 */
export function isAvailabilityError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /\[P7M_AVAILABILITY\]/.test(detail);
}

export function commandFailureMessage(label: string, error: unknown): string {
  const rawDetail = error instanceof Error ? error.message : String(error);
  const detail = rawDetail.replace(
    /\[P7M_(?:DOMAIN|AUTHENTICATION|AVAILABILITY)\]\s*/g,
    "",
  );
  if (isAvailabilityError(error)) {
    return `${label}: não foi possível confirmar o commit (${detail}). ` +
      "A projeção otimista foi mantida pendente; o journal ou a próxima ressincronização decidirá o estado canônico.";
  }
  return `${label} foi rejeitada (${detail}). ` +
    "A projeção local foi restaurada; corrija os dados e tente novamente.";
}
