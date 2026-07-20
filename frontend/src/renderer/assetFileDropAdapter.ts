/** Boundary injetável para `webUtils.getPathForFile`; o core nunca lê `File.path`. */
export interface DroppedFilePathAdapter {
  pathOf(file: File): string | undefined;
}

export function asepriteSourcePaths(
  files: Iterable<File> | ArrayLike<File>,
  adapter: DroppedFilePathAdapter,
): readonly string[] {
  const values = isIterable(files) ? [...files] : Array.from(files);
  const paths = values
    .filter((file) => /\.(?:ase|aseprite)$/iu.test(file.name))
    .map((file) => adapter.pathOf(file))
    .filter((path): path is string => Boolean(path));
  return [...new Set(paths)];
}

function isIterable(value: object): value is Iterable<File> {
  return Symbol.iterator in value;
}
