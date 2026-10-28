// Renders public/icons/*.png from public/favicon.svg with the Chromium that Playwright finds.
// Usage: node scripts/make-icons.mjs   (set CHROMIUM_PATH if Chromium is not at the default location)
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium'
const svg = await readFile(new URL('../public/favicon.svg', import.meta.url), 'utf8')
const mark = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '').replace(/<rect width="512" height="512" rx="112" fill="#0b0b0b"\/>/, '')

const pages = {
  // Rounded icon, as in the favicon.
  'icon-192.png': { size: 192, html: svg },
  'icon-512.png': { size: 512, html: svg },
  // Maskable icons are cropped by the OS, so fill the canvas and keep the mark inside the central 80%.
  'icon-maskable-512.png': { size: 512, html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0b0b0b"/><g transform="translate(51.2 51.2) scale(.8)">${mark}</g></svg>` },
}

const browser = await chromium.launch({ executablePath })
for (const [name, { size, html }] of Object.entries(pages)) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${html}`)
  await writeFile(new URL(`../public/icons/${name}`, import.meta.url), await page.screenshot({ omitBackground: true, type: 'png' }))
  await page.close()
}
await browser.close()
console.log('Wrote', Object.keys(pages).join(', '))
