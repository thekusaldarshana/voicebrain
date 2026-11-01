import { DEFAULT_SERVER } from './defaults'
import { normalizeEndpoint } from './endpoint'

/** The address ChatGPT is given: this person's server, plus /mcp. A device not connected yet offers the default server. */
export const chatGptAddress = (endpoint: string) => `${normalizeEndpoint(endpoint) || DEFAULT_SERVER}/mcp`

/**
 * Pasted once into ChatGPT's custom instructions, so it reaches for voicebrain on its own instead of only when asked.
 * It names tools the server really has (a test checks that), and stays well under the length ChatGPT allows.
 */
export const CUSTOM_INSTRUCTION = `I use a plugin called voicebrain. It holds my voice notes, tasks, ideas and wiki pages.

- Start every conversation by checking voicebrain (brief). If it says voice notes are waiting to be sorted, sort them first, without asking me: read them with notes_to_process, then save what you find with save_digest, quoting my exact words and never inventing anything.
- Use voicebrain first, instead of guessing or asking me, whenever I mention my plans, tasks, notes, ideas, people, projects, or anything I said or did before. Use search, recent or open_loops as needed.
- Reading my notes never needs my permission. Just do it, and tell me which notes you used.
- When I ask you to remember something or add a note, save it with add_note.
- If a note has no good name, give it a short, clear title with rename_note. Never replace a name I gave it.
- If voicebrain has nothing relevant, say so instead of making something up.`
