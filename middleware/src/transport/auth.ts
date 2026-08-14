/**
 * Autenticação dos transports locais do editor.
 *
 * O segredo é efêmero e pertence ao processo main do Electron. Ele chega ao
 * middleware por uma única fonte explícita: ambiente OU arquivo privado. Este
 * módulo nunca registra nem inclui o valor do token em mensagens de erro.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";

export const EDITOR_AUTH_TOKEN_ENV = "GRIDSMITH_EDITOR_AUTH_TOKEN";
export const EDITOR_AUTH_TOKEN_FILE_ENV = "GRIDSMITH_EDITOR_AUTH_TOKEN_FILE";
export const AUTHENTICATION_ERROR_CODE = "GRIDSMITH_AUTHENTICATION_FAILED";

const TOKEN_BYTES = 32;
const MIN_TOKEN_CHARS = 32;

export class TransportAuthConfigurationError extends Error {
  readonly code = "GRIDSMITH_AUTH_CONFIGURATION";

  constructor(message: string) {
    super(message);
    this.name = "TransportAuthConfigurationError";
  }
}

/** Token de 256 bits em base64url, sem caracteres problemáticos para headers. */
export function generateTransportAuthToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Rejeita tokens vazios, curtos ou com whitespace/caracteres de controle. */
export function validateTransportAuthToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < MIN_TOKEN_CHARS ||
    /[\s\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TransportAuthConfigurationError(
      `editor transport token must contain at least ${MIN_TOKEN_CHARS} non-whitespace characters`,
    );
  }
  return value;
}

/**
 * Carrega o token sem fallback inseguro. Definir ambiente e arquivo ao mesmo
 * tempo é rejeitado para evitar que uma configuração obsoleta seja mascarada.
 */
export function loadTransportAuthToken(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env[EDITOR_AUTH_TOKEN_ENV];
  const filePath = env[EDITOR_AUTH_TOKEN_FILE_ENV];
  if (direct !== undefined && filePath !== undefined) {
    throw new TransportAuthConfigurationError(
      `${EDITOR_AUTH_TOKEN_ENV} and ${EDITOR_AUTH_TOKEN_FILE_ENV} are mutually exclusive`,
    );
  }
  if (direct !== undefined) return validateTransportAuthToken(direct);
  if (filePath === undefined || filePath.length === 0) {
    throw new TransportAuthConfigurationError(
      `missing editor transport token; set ${EDITOR_AUTH_TOKEN_ENV} or ${EDITOR_AUTH_TOKEN_FILE_ENV}`,
    );
  }
  return readPrivateTokenFile(filePath);
}

function readPrivateTokenFile(filePath: string): string {
  let descriptor: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch {
    throw new TransportAuthConfigurationError("editor transport token file cannot be read");
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new TransportAuthConfigurationError("editor transport token path must be a regular file");
    }
    if (process.platform !== "win32") {
      if ((stat.mode & 0o077) !== 0) {
        throw new TransportAuthConfigurationError(
          "editor transport token file must not grant group or other permissions",
        );
      }
      const getuid = process.getuid;
      if (typeof getuid === "function" && stat.uid !== getuid()) {
        throw new TransportAuthConfigurationError(
          "editor transport token file must be owned by the current user",
        );
      }
    }
    return validateTransportAuthToken(fs.readFileSync(descriptor, "utf8").trim());
  } catch (error) {
    if (error instanceof TransportAuthConfigurationError) throw error;
    throw new TransportAuthConfigurationError("editor transport token file cannot be read");
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Comparação constante quando os comprimentos coincidem; nunca lança. */
export function timingSafeTokenEqual(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function bearerAuthorization(token: string): string {
  return `Bearer ${validateTransportAuthToken(token)}`;
}

/** Extrai Bearer sem aceitar listas, token vazio ou whitespace interno. */
export function extractBearerToken(header: string | readonly string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer ([^\s]+)$/iu.exec(header);
  return match?.[1];
}

export function bearerTokenMatches(
  header: string | readonly string[] | undefined,
  expectedToken: string,
): boolean {
  const supplied = extractBearerToken(header);
  return supplied !== undefined && timingSafeTokenEqual(expectedToken, supplied);
}
