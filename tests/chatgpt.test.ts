import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { CUSTOM_INSTRUCTION, chatGptAddress } from '../src/lib/chatgpt'
import { DEFAULT_SERVER } from '../src/lib/defaults'

describe('the address given to ChatGPT', () => {
  it('is this device’s server with /mcp, whatever way the address was typed', () => {
    expect(chatGptAddress('https://vb.example.com')).toBe('https://vb.example.com/mcp')
    expect(chatGptAddress('vb.example.com/')).toBe('https://vb.example.com/mcp')
    expect(chatGptAddress('  https://vb.example.com///  ')).toBe('https://vb.example.com/mcp')
  })

  it('offers the default server before this device is connected, and never a broken address', () => {
    expect(chatGptAddress('')).toBe(`${DEFAULT_SERVER}/mcp`)
    expect(chatGptAddress('not an address')).toBe(`${DEFAULT_SERVER}/mcp`)
  })
})

describe('the instruction pasted into ChatGPT', () => {
  const tools = [...readFileSync(new URL('../server/src/mcp.ts', import.meta.url), 'utf8').matchAll(/registerTool\('([a-z_]+)'/g)].map(match => match[1])

  it('only names tools the server really has', () => {
    const named = [...CUSTOM_INSTRUCTION.matchAll(/\b(brief|search|recent|open_loops|get_note|update_task|rename_note|add_note|list_wiki|read_wiki|write_wiki|notes_to_process|save_digest)\b/g)].map(match => match[1])
    expect(named.length).toBeGreaterThan(3)
    expect(named).toContain('notes_to_process') // ChatGPT sorts the notes: there is no other AI on the server
    expect(named).toContain('save_digest')
    for (const name of named) expect(tools, name).toContain(name)
  })

  it('is short enough for ChatGPT’s custom instructions and says what plugin it is about', () => {
    expect(CUSTOM_INSTRUCTION.length).toBeLessThan(1500)
    expect(CUSTOM_INSTRUCTION).toContain('voicebrain')
  })
})
