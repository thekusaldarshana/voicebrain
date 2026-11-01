import { DEFAULT_SERVER } from './defaults'
import { normalizeEndpoint } from './endpoint'

/** The address ChatGPT is given: this person's server, plus /mcp. A device not connected yet offers the default server. */
export const chatGptAddress = (endpoint: string) => `${normalizeEndpoint(endpoint) || DEFAULT_SERVER}/mcp`
