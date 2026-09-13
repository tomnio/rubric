import type { AnthropicImageBlock, ContentBlock, ImageUrlBlock } from "./types.js"

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

/** Anthropic image part from a public URL. */
export function anthropicImageUrl(url: string): AnthropicImageBlock {
  return { type: "image", source: { type: "url", url } }
}

/** Anthropic image part from raw base64 (no data: prefix). */
export function anthropicImageBase64(
  data: string,
  mediaType: string,
): AnthropicImageBlock {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data },
  }
}

const DATA_URL = /^data:([^;]+);base64,(.+)$/

/** Map OpenAI `image_url` parts to Anthropic `image` parts. Other blocks unchanged. */
export function toAnthropicContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) => {
    if (block.type !== "image_url") {
      return block
    }
    const url = block.image_url.url
    const dataUrl = url.match(DATA_URL)
    if (dataUrl?.[1] !== undefined && dataUrl[2] !== undefined) {
      return anthropicImageBase64(dataUrl[2], dataUrl[1])
    }
    return anthropicImageUrl(url)
  })
}
