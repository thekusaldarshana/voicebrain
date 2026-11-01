import { describe, expect, it } from 'vitest'
import { chatGptAddress } from '../src/lib/chatgpt'
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
