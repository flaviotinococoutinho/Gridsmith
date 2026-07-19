import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandFailureMessage,
  isAvailabilityError,
} from "../src/core/canonicalCommandFeedback.js";

test("edição canônica: indisponibilidade mantém projeção otimista pendente", () => {
  const error = new Error("[P7M_AVAILABILITY] deadline exceeded");
  assert.equal(isAvailabilityError(error), true);
  assert.match(commandFailureMessage("Pintar", error), /mantida pendente/);
  assert.doesNotMatch(commandFailureMessage("Pintar", error), /P7M_AVAILABILITY/);
});

test("edição canônica: rejeição de domínio orienta restauração local", () => {
  const error = new Error("[P7M_DOMAIN] cell changed before patch");
  assert.equal(isAvailabilityError(error), false);
  assert.match(commandFailureMessage("Pintar", error), /foi rejeitada/);
  assert.match(commandFailureMessage("Pintar", error), /foi restaurada/);
});
