import type { Mode } from "../types.js"
import { anthropicToolsHandler } from "./anthropic-tools.js"
import { jsonSchemaHandler } from "./json-schema.js"
import { mdJsonHandler } from "./md-json.js"
import { toolsHandler } from "./tools.js"
import type { ModeHandler } from "./types.js"

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
