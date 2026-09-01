import assert from "node:assert/strict";
import { test } from "node:test";
import { IntGridDocument } from "../src/core/intGridDocument.js";

test("paint altera a célula e devolve o que mudou, com o before original", () => {
  // o `before` é o que o domínio confere para detectar pintura sobre leitura
  // velha; devolvê-lo errado faria o servidor recusar um gesto legítimo
  const doc = new IntGridDocument(4, 3);
  assert.deepEqual(doc.paint(1, 1, 5), [{ index: 5, before: 0, after: 5 }]);
  assert.equal(doc.valueAt(1, 1), 5);
  assert.deepEqual(doc.paint(1, 1, 6), [{ index: 5, before: 5, after: 6 }]);
});

test("pintar o valor que já está lá não muda nada: lote vazio", () => {
  const doc = new IntGridDocument(2, 2);
  doc.paint(0, 0, 1);
  assert.deepEqual(doc.paint(0, 0, 1), []);
});

test("o documento NÃO tem histórico próprio — quem desfaz é o canônico (F6)", () => {
  // a superfície é a garantia: enquanto existir um undo aqui, alguém vai
  // ligá-lo a um botão e o editor volta a ter duas verdades
  const doc = new IntGridDocument(2, 2) as unknown as Record<string, unknown>;
  for (const membro of ["undo", "redo", "canUndo", "canRedo"]) {
    assert.equal(membro in doc, false, `IntGridDocument não deve expor "${membro}"`);
  }
});

test("fillRect aceita cantos em qualquer ordem e devolve o bloco inteiro", () => {
  const doc = new IntGridDocument(5, 5);
  doc.paint(2, 2, 9); // célula pré-existente dentro do retângulo
  const changes = doc.fillRect(3, 3, 1, 1, 7);
  assert.equal(changes.length, 9);

  for (let y = 1; y <= 3; y++) {
    for (let x = 1; x <= 3; x++) {
      assert.equal(doc.valueAt(x, y), 7);
    }
  }
  assert.equal(doc.valueAt(0, 0), 0);

  // o lote carrega o valor ANTERIOR de cada célula, inclusive o 9 que já
  // estava lá: é com ele que o inverso do comando canônico se monta
  assert.deepEqual(
    changes.find((c) => c.index === 12),
    { index: 12, before: 9, after: 7 },
  );
});

test("floodFill preenche só a região 4-conectada", () => {
  //  1 1 0
  //  0 1 0
  //  0 0 1   ← o canto (2,2) NÃO é conectado ao grupo
  const doc = new IntGridDocument(3, 3, [1, 1, 0, 0, 1, 0, 0, 0, 1]);
  const changes = doc.floodFill(0, 0, 4);

  assert.deepEqual(doc.snapshot(), [4, 4, 0, 0, 4, 0, 0, 0, 1]);
  assert.deepEqual(
    [...changes].map((c) => c.index).sort((a, b) => a - b),
    [0, 1, 4],
  );
});

test("floodFill com o mesmo valor é no-op", () => {
  const doc = new IntGridDocument(2, 2, [3, 3, 3, 3]);
  assert.deepEqual(doc.floodFill(0, 0, 3), []);
});

test("toLevelPayload produz o shape do comando level/define", () => {
  const doc = new IntGridDocument(2, 2);
  doc.fillRect(0, 1, 1, 1, 1); // linha de baixo preenchida
  const rules = [{ patternSize: 1, pattern: [1], tileIds: [200] }];
  const payload = doc.toLevelPayload({ levelId: "l1", tileSize: 16, seed: 9, rules });

  assert.deepEqual(payload, {
    levelId: "l1",
    width: 2,
    height: 2,
    tileSize: 16,
    seed: 9,
    intGrid: [0, 0, 1, 1],
    rules,
  });
});

test("validações: célula fora do grid, valor inválido, dimensões erradas", () => {
  const doc = new IntGridDocument(2, 2);
  assert.throws(() => doc.paint(2, 0, 1), RangeError);
  assert.throws(() => doc.paint(0, 0, -1), RangeError);
  assert.throws(() => doc.paint(0, 0, 1.5), RangeError);
  assert.throws(() => new IntGridDocument(0, 2), RangeError);
  assert.throws(() => new IntGridDocument(2, 2, [1]), RangeError);
});

test("paintLine traça Bresenham inclusiva em qualquer octante", () => {
  const doc = new IntGridDocument(6, 6);
  assert.equal(doc.paintLine(0, 0, 5, 2, 4).length, 6);
  // extremos sempre pintados; linha contínua (célula por coluna neste octante)
  assert.equal(doc.valueAt(0, 0), 4);
  assert.equal(doc.valueAt(5, 2), 4);
  const painted = doc.snapshot().filter((v) => v === 4).length;
  assert.equal(painted, 6); // uma célula por coluna (dx dominante)

  // linha vertical e diagonal invertida também funcionam
  assert.equal(doc.paintLine(3, 4, 3, 1, 2).length, 4);
  assert.equal(doc.valueAt(3, 1), 2);
  assert.equal(doc.valueAt(3, 4), 2);
});

test("paintLine sobre células já corretas é no-op", () => {
  const doc = new IntGridDocument(3, 1, [7, 7, 7]);
  assert.deepEqual(doc.paintLine(0, 0, 2, 0, 7), []);
});

test("lineCells é inclusiva e simétrica nos extremos", async () => {
  const { lineCells } = await import("../src/core/intGridDocument.js");
  const forward = lineCells(0, 0, 3, 3);
  assert.deepEqual(forward[0], [0, 0]);
  assert.deepEqual(forward[forward.length - 1], [3, 3]);
  assert.equal(forward.length, 4); // diagonal perfeita: uma célula por passo
  assert.equal(lineCells(2, 2, 2, 2).length, 1); // ponto único
});
