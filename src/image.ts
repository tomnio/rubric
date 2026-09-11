import type { ImageUrlBlock } from "./types.js"

/** OpenAI image part for `messages[].content`. */
export function imageUrl(
  url: string,
  detail?: "auto" | "low" | "high",
): ImageUrlBlock {
  if (detail === undefined) {
    return { type: "image_url", image_url: { url } }
  }
  return { type: "image_url", image_url: { url, detail } }
}
