import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import protobuf from "protobufjs";

/**
 * Guarda-corpo PERMANENTE da decisão da Onda 0.
 *
 * O `EventEnvelope` da main publicou os campos 7, 8 e 9 como
 * `has_projection`/`projection_status`/`projection_reason`. A implementação de
 * referência do branch fechado ocupava EXATAMENTE esses números com
 * `transaction_id`/`document_state_id`/`history_entry_id`.
 *
 * Isso não é conflito de texto: em proto3 o número do campo É a identidade no
 * fio. Um build que reaproveitasse 7/8/9 decodificaria um campo como o outro
 * em SILÊNCIO — um cliente antigo leria o id de uma transação onde esperava
 * saber se a projeção aconteceu. Por isso o histórico entra a partir do 10, e
 * este teste prova que a compatibilidade vale nos dois sentidos.
 */

const ENVELOPE_ANTIGO = `
syntax = "proto3";
package p7m.editor.v1;

message EventEnvelope {
  uint64 seq = 1;
  string kind = 2;
  string payload_json = 3;
  string project_session_id = 4;
  string project_id = 5;
  uint64 command_sequence = 6;
  bool has_projection = 7;
  string projection_status = 8;
  string projection_reason = 9;
}
`;

/**
 * NOTA: o protobufjs expõe os campos em camelCase. Isso é só a superfície JS —
 * o que este teste exercita é a camada BINÁRIA, onde a identidade do campo é o
 * NÚMERO, e é justamente o número que a Onda 0 congelou.
 */
type EnvelopeType = protobuf.Type;

function carregar(protoPath: string): EnvelopeType {
  return protobuf.loadSync(protoPath).lookupType("p7m.editor.v1.EventEnvelope");
}

function envelopeAntigo(): EnvelopeType {
  const dir = mkdtempSync(path.join(tmpdir(), "p7m-envelope-"));
  const file = path.join(dir, "legacy_envelope.proto");
  writeFileSync(file, ENVELOPE_ANTIGO);
  return carregar(file);
}

function envelopeNovo(): EnvelopeType {
  return carregar(path.join(import.meta.dirname, "..", "..", "contracts", "grpc", "p7m_editor.proto"));
}

test("bytes do servidor NOVO preservam a projeção quando lidos pelo cliente ANTIGO", () => {
  const novo = envelopeNovo();
  const antigo = envelopeAntigo();

  const bytes = novo
    .encode(novo.create({
      seq: 42,
      kind: "levelPatched",
      payloadJson: "{}",
      projectSessionId: "s1",
      projectId: "p1",
      commandSequence: 7,
      hasProjection: true,
      projectionStatus: "deferred",
      projectionReason: "no engine session connected",
      // campos 10-15: o cliente antigo não os conhece
      transactionId: "gesto-1",
      documentStateId: "h3",
      historyEntryId: "h3",
      actor: "human",
      historyAction: "undo",
      historyCursor: "2",
    }))
    .finish();

  const lido = antigo.decode(bytes).toJSON() as Record<string, unknown>;

  assert.equal(lido["hasProjection"], true, "o campo 7 continua sendo has_projection");
  assert.equal(lido["projectionStatus"], "deferred", "o campo 8 continua sendo projection_status");
  assert.equal(
    lido["projectionReason"],
    "no engine session connected",
    "o campo 9 continua sendo projection_reason",
  );
  assert.equal(lido["kind"], "levelPatched");
  assert.equal(lido["commandSequence"], "7");
  // o cliente antigo simplesmente IGNORA os campos 10-15 (unknown fields)
  assert.equal(Object.hasOwn(lido, "transactionId"), false);
});

test("bytes do servidor ANTIGO dão campos de histórico VAZIOS no cliente novo, sem erro", () => {
  const novo = envelopeNovo();
  const antigo = envelopeAntigo();

  const bytes = antigo
    .encode(antigo.create({
      seq: 1,
      kind: "lightAdded",
      payloadJson: "{}",
      projectSessionId: "s1",
      projectId: "p1",
      commandSequence: 1,
      hasProjection: true,
      projectionStatus: "projected",
    }))
    .finish();

  const lido = novo.decode(bytes).toJSON() as Record<string, unknown>;

  assert.equal(lido["projectionStatus"], "projected");
  assert.equal(lido["hasProjection"], true);
  // proto3: campo ausente decodifica como o default do tipo — o que importa é
  // que NÃO vira lixo nem colide com os campos de projeção.
  for (const campo of ["transactionId", "documentStateId", "historyAction", "actor"]) {
    assert.equal(lido[campo] ?? "", "", `${campo} veio vazio, não com lixo`);
  }
});

test("os campos 7, 8 e 9 do envelope são imutáveis — o proto declara isso por número", () => {
  // Um teste textual complementa o binário: se alguém RENOMEAR o campo 7 sem
  // mudar o número, os dois testes acima continuariam passando enquanto o
  // significado publicado teria mudado.
  // Escopado à mensagem: o mesmo nome existe em outras mensagens com outros
  // números, e comparar contra o arquivo inteiro daria falso positivo.
  const proto = envelopeBlock();
  assert.match(proto, /bool has_projection = 7;/, "campo 7 é has_projection");
  assert.match(proto, /string projection_status = 8;/, "campo 8 é projection_status");
  assert.match(proto, /string projection_reason = 9;/, "campo 9 é projection_reason");
  // e nenhum campo de histórico usa número abaixo de 10
  for (const nome of [
    "transaction_id",
    "document_state_id",
    "history_entry_id",
    "actor",
    "history_action",
    "history_cursor",
  ]) {
    const match = new RegExp(`string ${nome} = (\\d+);`).exec(proto);
    assert.ok(match, `${nome} declarado no envelope`);
    assert.ok(
      Number(match[1]) >= 10,
      `${nome} usa o campo ${match[1]}; histórico começa no 10 (7-9 pertencem à projeção)`,
    );
  }
});

/** Só o corpo de `message EventEnvelope { ... }`. */
function envelopeBlock(): string {
  const proto = readFileSync(
    path.join(import.meta.dirname, "..", "..", "contracts", "grpc", "p7m_editor.proto"),
    "utf8",
  );
  const match = /message EventEnvelope \{([\s\S]*?)\n\}/.exec(proto);
  assert.ok(match, "message EventEnvelope encontrada no contrato");
  return match[1]!;
}
