/**
 * Política de ARTE do ator: dado o sprite da definição (documento v6) e os
 * atlas que a sessão carregou, o que o marcador desenha.
 *
 * O host decide o mesmo com os mesmos dados (`GridsmithGame.TryActorSprite`):
 * amostra o atlas quando a tabela cobre o tile e a imagem existe; em QUALQUER
 * outra situação — sem sprite, tileset removido, imagem recusada, id fora da
 * faixa — pinta a cor lisa do ator. A degradação é CONJUNTA: nunca um lado
 * mostra arte que o outro não tem.
 *
 * O atlas de um sprite não é necessariamente o do nível: a definição escolhe o
 * seu, e um cache só do nível faria o marcador degradar por falta de CARGA, e
 * não por falta de arte — degradação que o host não acompanharia.
 *
 * Módulo puro (regra F1): genérico na imagem, para não conhecer o DOM.
 */

import { tileRegion, type AtlasRegion, type TilesetTable } from "./tilesetAtlas.js";

/** O par que a definição carrega — espelho do `EntitySprite` do domínio. */
export interface EntitySpriteRef {
  readonly tilesetId: string;
  readonly tileId: number;
}

/**
 * Atlas conhecido pela sessão. `image` distingue três estados que o desenho
 * trata diferente: `undefined` ainda carregando, `null` recusada (cache
 * negativo) e a imagem pronta.
 */
export interface AtlasEntry<TImage> {
  readonly table: TilesetTable;
  readonly image?: TImage | null;
}

export type EntityArt<TImage> =
  | { readonly kind: "tile"; readonly image: TImage; readonly region: AtlasRegion }
  | { readonly kind: "marker" };

/**
 * Arte do ator, ou `marker` quando não há arte que o host também desenharia.
 */
export function resolveEntityArt<TImage>(
  sprite: EntitySpriteRef | undefined,
  atlasOf: (tilesetId: string) => AtlasEntry<TImage> | undefined,
): EntityArt<TImage> {
  if (typeof sprite?.tilesetId !== "string" || sprite.tilesetId.length === 0) {
    return { kind: "marker" };
  }
  const atlas = atlasOf(sprite.tilesetId);
  // `null` (recusada) e `undefined` (carregando) caem no marcador: desenhar
  // otimista enquanto a imagem não chegou piscaria arte que pode não existir
  if (!atlas?.image) return { kind: "marker" };
  const region = tileRegion(atlas.table, sprite.tileId);
  return region ? { kind: "tile", image: atlas.image, region } : { kind: "marker" };
}

/**
 * Tilesets que a sessão precisa carregar: o do nível e o de cada sprite de
 * definição, na ordem em que aparecem e sem repetição. Pedir a imagem duas
 * vezes por dois atores do mesmo archetype seria IPC gratuito.
 */
export function requiredTilesetIds(
  levelTilesetId: string | undefined,
  definitions: Iterable<{ readonly sprite?: EntitySpriteRef }>,
): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined): void => {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  add(levelTilesetId);
  for (const definition of definitions) add(definition.sprite?.tilesetId);
  return ids;
}
