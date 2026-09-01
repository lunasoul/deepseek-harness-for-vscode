import { describe, expect, it } from 'vitest'

import { clipboardImageFiles } from '../src/webview/chat/clipboard-images.js'

function imageFile(name: string, size: number, lastModified: number, type = 'image/png'): File {
  return { name, size, lastModified, type } as File
}

function imageItem(file: File | null, type = 'image/png'): DataTransferItem {
  return { kind: 'file', type, getAsFile: () => file } as DataTransferItem
}

describe('clipboardImageFiles', () => {
  it('uses clipboard items as the authoritative source instead of duplicating their files view', () => {
    const fromItem = imageFile('image.png', 1024, 100)
    const fromFiles = imageFile('image.png', 1024, 101)

    expect(clipboardImageFiles({
      items: [imageItem(fromItem)],
      files: [fromFiles],
    })).toEqual([fromItem])
  })

  it('falls back to direct files when no readable image item is available', () => {
    const direct = imageFile('image.png', 1024, 100)

    expect(clipboardImageFiles({
      items: [imageItem(null)],
      files: [direct],
    })).toEqual([direct])
  })

  it('preserves distinct images and removes exact duplicates within the selected source', () => {
    const first = imageFile('first.png', 100, 1)
    const duplicate = imageFile('first.png', 100, 1)
    const second = imageFile('second.png', 200, 2)

    expect(clipboardImageFiles({
      items: [imageItem(first), imageItem(duplicate), imageItem(second)],
      files: [],
    })).toEqual([duplicate, second])
  })

  it('ignores non-image clipboard entries and files', () => {
    const textFile = imageFile('notes.txt', 20, 1, 'text/plain')

    expect(clipboardImageFiles({
      items: [imageItem(textFile, 'text/plain')],
      files: [textFile],
    })).toEqual([])
  })
})
