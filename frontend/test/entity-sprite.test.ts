import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requiredTilesetIds,
  resolveEntityArt,
  type AtlasEntry,
} from "../src/core/entitySprite.js";
import type { TilesetTable } from "../src/core/tilesetAtlas.js";

/**
 * Cada caso de degradação aqui tem um gêmeo do outro lado do fio: o host cai
 * na cor lisa do ator (`GridsmithGame.TryActorSprite`) pelas MESMAS condições.
 * Um lado que resolvesse arte onde o outro não resolve seria o editor mentindo
 * sobre o jogo.
 */
const TERRENO: TilesetTable = {
  tilesetId: "terreno",
  image: "assets/terreno.png",
  tileSize: 16,
  columns: 8,
  tileCount: 48,
};

const carregado = (image: string): AtlasEntry<string> => ({ table: TERRENO, image });
const atlasPronto = (): AtlasEntry<string> | undefined => carregado("pixels");

test("com atlas carregado e id na faixa, a arte é a região da fórmula", () => {
  const art = resolveEntityArt({ tilesetId: "terreno", tileId: 9 }, atlasPronto);
  assert.equal(art.kind, "tile");
  assert.equal(art.kind === "tile" ? art.image : undefined, "pixels");
  assert.deepEqual(art.kind === "tile" ? art.region : undefined, {
    x: 16,
    y: 16,
    width: 16,
    height: 16,
  });
});

test("sem sprite na definição o ator continua marcador — não há arte a inventar", () => {
  assert.equal(resolveEntityArt(undefined, atlasPronto).kind, "marker");
  assert.equal(resolveEntityArt({ tilesetId: "", tileId: 3 }, atlasPronto).kind, "marker");
});

test("tileset desconhecido, imagem recusada e imagem CARREGANDO caem no marcador", () => {
  // o tileset pode ter sido removido enquanto a definição sobreviveu
  assert.equal(resolveEntityArt({ tilesetId: "outro", tileId: 3 }, () => undefined).kind, "marker");
  // `null` é o cache NEGATIVO: a carga já falhou
  assert.equal(
    resolveEntityArt({ tilesetId: "terreno", tileId: 3 }, () => ({ table: TERRENO, image: null }))
      .kind,
    "marker",
  );
  // `undefined` é "ainda carregando": desenhar otimista piscaria arte que
  // pode não existir, e o host nunca pisca
  assert.equal(
    resolveEntityArt({ tilesetId: "terreno", tileId: 3 }, () => ({ table: TERRENO })).kind,
    "marker",
  );
});

test("id fora de [0, tileCount) é ausência de arte, não erro", () => {
  assert.equal(resolveEntityArt({ tilesetId: "terreno", tileId: 48 }, atlasPronto).kind, "marker");
  assert.equal(resolveEntityArt({ tilesetId: "terreno", tileId: -1 }, atlasPronto).kind, "marker");
});

test("a sessão carrega o atlas do nível E o de cada sprite, sem repetir", () => {
  const ids = requiredTilesetIds("terreno", [
    { sprite: { tilesetId: "personagens", tileId: 0 } },
    { sprite: { tilesetId: "terreno", tileId: 4 } }, // já é o do nível
    {}, // definição sem sprite
    { sprite: { tilesetId: "personagens", tileId: 7 } }, // já pedido
  ]);
  assert.deepEqual(ids, ["terreno", "personagens"]);
});

test("nível sem tileset ainda carrega os atlas dos sprites", () => {
  assert.deepEqual(requiredTilesetIds(undefined, [{ sprite: { tilesetId: "personagens", tileId: 0 } }]), [
    "personagens",
  ]);
  assert.deepEqual(requiredTilesetIds(undefined, []), []);
});
