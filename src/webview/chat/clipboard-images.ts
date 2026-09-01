interface ClipboardImageData {
  readonly items?: ArrayLike<DataTransferItem>
  readonly files?: ArrayLike<File>
}

/**
 * Returns one authoritative view of the images carried by a paste event.
 * Chromium exposes clipboard files through both `items` and `files`; combining
 * those views can turn one Windows clipboard image into two attachments when
 * the separately materialized File objects have different metadata.
 */
export function clipboardImageFiles(clipboardData: ClipboardImageData): readonly File[] {
  const itemFiles = clipboardData.items === undefined
    ? []
    : Array.from(clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file) => file !== null)

  return uniqueFiles(itemFiles.length > 0
    ? itemFiles
    : clipboardData.files === undefined
      ? []
      : Array.from(clipboardData.files).filter((file) => file.type.startsWith('image/')))
}

function uniqueFiles(files: readonly File[]): readonly File[] {
  return [...new Map(files.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file])).values()]
}
