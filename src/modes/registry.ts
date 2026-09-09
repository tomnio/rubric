import type { Mode } from "../types.ts"
import { anthropicToolsHandler } from "./anthropic-tools.ts"
import { jsonSchemaHandler } from "./json-schema.ts"
import { mdJsonHandler } from "./md-json.ts"
import { toolsHandler } from "./tools.ts"
import type { ModeHandler } from "./types.ts"

export function handlerFor(mode: Mode): ModeHandler {
  switch (mode) {
    case "TOOLS":
      return toolsHandler
    case "JSON_SCHEMA":
      return jsonSchemaHandler
    case "MD_JSON":
      return mdJsonHandler
    case "ANTHROPIC_TOOLS":
      return anthropicToolsHandler
  }
}
