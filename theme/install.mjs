// Installs the Seuil "Campfire" background in Windows Terminal.
//   node theme/install.mjs                adds a "Seuil · Campfire" profile to the new-tab menu
//   node theme/install.mjs --everywhere   also applies it to every profile (profiles.defaults): all tabs, open or new
//   node theme/install.mjs --remove       removes everything this script added, including that setting
// Without --everywhere nothing else changes: the theme is one more profile in the menu.
// Before its first write to the terminal's settings, a copy is kept: settings.json.before-seuil-theme.
// Windows only, no dependency (Node 18+).
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
  console.error('This theme is for Windows Terminal, on Windows.')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const installed = join(process.env.LOCALAPPDATA, 'Seuil', 'theme')
const fragment = join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows Terminal', 'Fragments', 'Seuil')
// Stable, Preview, then the unpackaged build: the first settings file that exists.
const settingsFile = [
  join(process.env.LOCALAPPDATA, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
  join(process.env.LOCALAPPDATA, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
  join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows Terminal', 'settings.json'),
].find(file => existsSync(file))

export const THEMES = [
  {
    key: 'campfire', name: 'Campfire', guid: '{5e0117e0-7e11-4a00-9000-000000000102}',
    colors: {
      background: '#08080A', foreground: '#D5DBE8', cursorColor: '#FFB454', selectionBackground: '#2A3340',
      black: '#16161A', red: '#F7768E', green: '#9ECE6A', yellow: '#FFD27A', blue: '#7AA2F7', purple: '#BB9AF7', cyan: '#7DCFFF', white: '#B8C0D4',
      brightBlack: '#5F6B85', brightRed: '#FF98AA', brightGreen: '#B8E08A', brightYellow: '#FFE0A0', brightBlue: '#9DBCFF', brightPurple: '#CFB6FF', brightCyan: '#A6E0FF', brightWhite: '#EEF2FA',
    },
  },
]

const source = (t, ext) => join(here, t.key, `${t.key}.${ext}`)
// Installed files carry a fingerprint of their content: when a theme changes, its path changes, and Windows
// Terminal reloads the shader in tabs already open (it does not re-read a file under the same name).
const fingerprint = t => createHash('sha1').update(readFileSync(source(t, 'hlsl'))).update(readFileSync(source(t, 'png'))).digest('hex').slice(0, 8)
const target = (t, ext) => join(installed, t.key, `${t.key}-${fingerprint(t)}.${ext}`)
const ours = path => String(path ?? '').startsWith(installed)

// Windows Terminal's settings are JSON with comments and trailing commas (its default file has both): strip them,
// outside strings, before parsing.
const parseJsonc = source => {
  // Walks the text outside strings: `keep(i)` says what to do with each character there.
  const walk = (text, step) => {
    let out = ''

    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') {
        let j = i + 1

        while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
        out += text.slice(i, j + 1)
        i = j
      } else {
        const [add, skip] = step(text, i)

        out += add
        i += skip
      }
    }

    return out
  }
  const noComments = walk(source.replace(/^﻿/, ''), (text, i) => {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i)

      return ['\n', (end === -1 ? text.length : end) - i]
    }

    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2)

      return [' ', (end === -1 ? text.length : end + 2) - i - 1]
    }

    return [text[i], 0]
  })
  const noTrailingCommas = walk(noComments, (text, i) => [text[i] === ',' && /^\s*[}\]]/.test(text.slice(i + 1)) ? '' : text[i], 0])

  return JSON.parse(noTrailingCommas)
}

// True once the settings read held comments or trailing commas: rewriting them drops those, the copy keeps them.
let loose = false

const readSettings = () => {
  try {
    const text = readFileSync(settingsFile, 'utf8')

    try {
      return JSON.parse(text.replace(/^﻿/, ''))
    } catch {
      loose = true

      return parseJsonc(text)
    }
  } catch (error) {
    console.error(`Could not read Windows Terminal's settings, nothing changed there: ${error.message}`)

    return undefined
  }
}

// Makes Windows Terminal read its settings again (it reads fragments only then).
const touch = () => {
  try {
    if (settingsFile) utimesSync(settingsFile, new Date(), new Date())
  } catch {
    // Windows Terminal installed some other way: the profile appears when it next starts.
  }
}

// What --everywhere writes into profiles.defaults, and --remove takes out.
const KEYS = ['colorScheme', 'experimental.pixelShaderPath', 'experimental.pixelShaderImagePath']

// Applies the theme to every profile (theme = null: removes that setting). Returns false when nothing was written.
const everywhere = theme => {
  if (!settingsFile) return false

  const json = readSettings()

  if (!json) return false

  if (!existsSync(`${settingsFile}.before-seuil-theme`)) cpSync(settingsFile, `${settingsFile}.before-seuil-theme`)

  const defaults = { ...json.profiles?.defaults }

  if (theme) {
    defaults.colorScheme = `Seuil ${theme.name}`
    defaults['experimental.pixelShaderPath'] = target(theme, 'hlsl')
    defaults['experimental.pixelShaderImagePath'] = target(theme, 'png')
  } else if (ours(defaults['experimental.pixelShaderPath'])) for (const key of KEYS) delete defaults[key]

  json.profiles = { ...json.profiles, defaults }
  // Profiles of themes no longer in the pack, which the terminal kept in memory, go away.
  json.profiles.list = (json.profiles.list ?? []).filter(p => p.source !== 'Seuil' || (theme !== null && THEMES.some(t => t.guid === p.guid)))
  writeFileSync(settingsFile, `${JSON.stringify(json, null, 4)}\n`)

  if (loose) console.log(`Windows Terminal's settings were rewritten without their comments; the original is in ${settingsFile}.before-seuil-theme.`)

  return true
}

if (process.argv.includes('--remove')) {
  everywhere(null)
  rmSync(fragment, { recursive: true, force: true })
  rmSync(installed, { recursive: true, force: true })
  touch()
  console.log('Seuil theme removed.')
} else {
  // Already applied everywhere: it stays so; its files change names, the settings follow.
  const keepEverywhere = process.argv.includes('--everywhere') || ours(readSettings()?.profiles?.defaults?.['experimental.pixelShaderPath'])

  rmSync(installed, { recursive: true, force: true })

  for (const t of THEMES) {
    mkdirSync(join(installed, t.key), { recursive: true })
    cpSync(source(t, 'hlsl'), target(t, 'hlsl'))
    cpSync(source(t, 'png'), target(t, 'png'))
  }

  mkdirSync(fragment, { recursive: true })
  writeFileSync(join(fragment, 'seuil.json'), `${JSON.stringify({
    schemes: THEMES.map(t => ({ name: `Seuil ${t.name}`, ...t.colors })),
    profiles: THEMES.map(t => ({
      guid: t.guid,
      name: `Seuil · ${t.name}`,
      commandline: 'powershell.exe -NoLogo',
      startingDirectory: homedir(),
      colorScheme: `Seuil ${t.name}`,
      'experimental.pixelShaderPath': target(t, 'hlsl'),
      'experimental.pixelShaderImagePath': target(t, 'png'),
      cursorShape: 'bar',
      tabColor: t.colors.background,
      padding: '12',
    })),
  }, null, 2)}\n`)

  if (keepEverywhere && everywhere(THEMES[0])) console.log(`"${THEMES[0].name}" applied to every Windows Terminal profile.`)
  else touch()

  console.log(`Installed: ${THEMES.map(t => `Seuil · ${t.name}`).join(', ')}. Open it from the new-tab menu.`)
}
