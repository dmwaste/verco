/**
 * Client-side photo compression for field evidence uploads. Crew phones
 * shoot 12MP+ images; uploading originals over 4G stalls the closeout flow.
 * Downscales the longest edge to ~1600px and re-encodes as JPEG.
 *
 * Browser-only (canvas). Falls back to the original file on ANY failure —
 * a failed compression must never block an NCN/NP photo upload.
 */
export async function compressImage(
  file: File,
  maxDimension = 1600,
  quality = 0.8,
): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))

    // Already small enough and already a JPEG — nothing to gain.
    if (scale === 1 && file.type === 'image/jpeg') {
      bitmap.close()
      return file
    }

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return file
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    )
    return blob ?? file
  } catch {
    return file
  }
}
