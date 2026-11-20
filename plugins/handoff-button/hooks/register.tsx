import type { EngineInterface as Engine, Register } from 'claude-code'

const SESSIONS = 'ccd_session_mgmt'
const VERSION = /\s\[([A-Z])\]\s*$/
const AFTER_CLEAR_MS = 2000
const IMPORT_MAX_CHARS = 200000
const IMPORT_PANE = 'import-chat'
const SETTINGS_PANE = 'handoff-button-settings'
const EDGE_SUBPATH = '\\Microsoft\\Edge\\Application\\msedge.exe'

// Resolved per machine and user on first use: no user name or install path is baked in.
let EXPORT_DIR = ''
let EDGE = ''

async function resolvePaths($: Engine) {
  if (EXPORT_DIR === '') {
    const home = (await $.env.get('USERPROFILE')) ?? 'C:\\Users\\Public'
    EXPORT_DIR = home + '\\Documents\\Claude Handoffs'
  }
  if (EDGE === '') {
    const candidates = [
      ((await $.env.get('ProgramFiles(x86)')) ?? 'C:\\Program Files (x86)') + EDGE_SUBPATH,
      ((await $.env.get('ProgramFiles')) ?? 'C:\\Program Files') + EDGE_SUBPATH,
    ]
    for (const candidate of candidates) {
      if (await $.fs.exists(candidate)) {
        EDGE = candidate
        break
      }
    }
  }
}

const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map(block => block.text ?? '').join('\n')

let isRunning = false
let logText = ''
let pendingHandoff: string | undefined
type Back = { id: string; title: string; path: string; pdf?: string }

let pendingBack: Omit<Back, 'id'> | undefined
let backTo: Back | undefined
let backFor = ''

// Drops what the app injects into user messages (system reminders, command
// caveats), which the person never typed.
const clean = (text: string) =>
  text
    .replace(/<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>/g, '')
    .trim()

const escapeHtml =(text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Prints the chat to a PDF with headless Edge; undefined when that fails.
async function makePdf(
  $: Engine,
  title: string,
  messages: readonly { role: string; text: string; toolUses: readonly { tool: string }[] }[],
  pdfPath: string,
) {
  if (EDGE === '') {
    await log($, 'pdf skipped: Microsoft Edge not found')
    return undefined
  }
  try {
    const rows = messages
      .filter(m => m.text.trim() !== '' || m.toolUses.length > 0)
      .map(m => {
        const who = m.role === 'user' ? 'Du' : 'Claude'
        const tools = m.toolUses.length === 0
          ? ''
          : `<div class="tools">${m.toolUses.map(use => escapeHtml(use.tool)).join(' · ')}</div>`
        return `<div class="msg ${m.role}"><div class="who">${who}</div><div class="text">${escapeHtml(m.text)}</div>${tools}</div>`
      })
      .join('\n')
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>` +
      'body{font:11pt/1.45 "Segoe UI",sans-serif;color:#222;margin:0}' +
      'h1{font-size:16pt;margin:0 0 4pt}.date{color:#888;font-size:9pt;margin-bottom:14pt}' +
      '.msg{margin:0 0 10pt;padding:8pt 10pt;border-radius:6pt;break-inside:avoid-page}' +
      '.user{background:#f1efe8}.assistant{border-left:3pt solid #d97757}' +
      '.who{font-weight:600;font-size:9pt;color:#666;margin-bottom:3pt}' +
      '.text{white-space:pre-wrap;word-wrap:break-word}.tools{color:#999;font-size:8.5pt;margin-top:4pt}' +
      '@page{margin:16mm}</style></head><body>' +
      `<h1>${escapeHtml(title)}</h1><div class="date">${new Date().toLocaleString('de-DE')}</div>${rows}</body></html>`
    const htmlPath = EXPORT_DIR + '\\.tmp\\chat.html'
    await $.fs.write(htmlPath, html)
    const url = 'file:///' + encodeURI(htmlPath.replace(/\\/g, '/'))
    const ran = await $.process.run([
      EDGE,
      '--headless=new',
      '--disable-gpu',
      '--no-pdf-header-footer',
      '--user-data-dir=' + EXPORT_DIR + '\\.tmp\\edge-profile',
      '--print-to-pdf=' + pdfPath,
      url,
    ], { timeoutMs: 90000 })
    if (!(await $.fs.exists(pdfPath))) {
      await log($, 'pdf failed: exit ' + ran.exitCode + ' ' + ran.stderr.slice(0, 300))
      return undefined
    }
    await log($, 'pdf ok: ' + pdfPath)
    return pdfPath
  } catch (error) {
    await log($, 'pdf error: ' + String(error))
    return undefined
  }
}

async function openPdf($: Engine, back: Back) {
  if (back.pdf === undefined || !(await $.fs.exists(back.pdf))) {
    $.ui.toast('Fuer "' + back.title + '" gibt es kein PDF. Mit /import-chat kannst du den Verlauf laden.')
    return
  }
  try {
    // explorer.exe opens the file in the default PDF viewer; its exit code means nothing.
    await $.process.run(['explorer.exe', back.pdf])
    await log($, 'opened pdf: ' + back.pdf)
  } catch (error) {
    await log($, 'open pdf failed: ' + String(error))
    $.ui.toast('PDF liess sich nicht oeffnen: ' + back.pdf)
  }
}

// C button: runs /compact straight away. The desktop app's session is headless, where
// $.session.compact is refused, so the command runs as /compact does; a typed /compact is the last resort.
async function compact($: Engine) {
  try {
    const ran = await $.command.run({ command: 'compact' })
    await log($, 'compact via command: ' + JSON.stringify(ran).slice(0, 200))
    return
  } catch (error) {
    await log($, 'compact command error: ' + String(error))
  }
  try {
    await $.prompt.submit({ text: '/compact', asUser: true })
    await log($, 'compact submitted as prompt')
  } catch (error) {
    await log($, 'compact prompt error: ' + String(error))
    $.ui.toast('Compact ging nicht: ' + String(error).slice(0, 200))
  }
}

// ⌾ button: runs /advisor <model> straight away, the same way C runs /compact.
async function advisor($: Engine) {
  const model = advisorModel
  try {
    const ran = await $.command.run({ command: 'advisor', args: model })
    await log($, 'advisor via command: ' + JSON.stringify(ran).slice(0, 200))
    return
  } catch (error) {
    await log($, 'advisor command error: ' + String(error))
  }
  try {
    await $.prompt.submit({ text: '/advisor ' + model, asUser: true })
    await log($, 'advisor submitted as prompt')
  } catch (error) {
    await log($, 'advisor prompt error: ' + String(error))
    $.ui.toast('Advisor ging nicht: ' + String(error).slice(0, 200))
  }
}

// H button: asks for a handover, as if the person had typed it. It runs once the chat is idle.
async function askHandover($: Engine) {
  try {
    await $.prompt.submit({ text: 'Bitte schreib ein Handover.', asUser: true })
  } catch (error) {
    $.ui.toast('Handover ging nicht: ' + String(error).slice(0, 200))
  }
}

async function log($: Engine, line: string) {
  await resolvePaths($)
  logText += new Date().toISOString() + ' ' + line + '\n'
  try {
    await $.fs.write(EXPORT_DIR + '\\handoff-log.txt', logText)
  } catch {
    // logging must never break the handoff
  }
}

async function handoff($: Engine, isWorking: boolean) {
  if (isWorking) {
    $.ui.toast('Handoff: erst warten, bis der Chat fertig geantwortet hat.')
    return
  }
  if (isRunning) {
    $.ui.toast('Handoff laeuft bereits.')
    return
  }
  isRunning = true
  await resolvePaths($)
  logText = ''
  await log($, 'start')

  try {
    const info = await $.mcp.call(SESSIONS, 'get_session', { session_id: 'self' })
    let title = 'Chat'
    try {
      title = JSON.parse(textOf(info)).title ?? title
    } catch {
      // keep the fallback title
    }

    const match = VERSION.exec(title)
    const base = match ? title.slice(0, match.index) : title
    const letter = match?.[1] ?? 'A'
    const next = String.fromCharCode(letter.charCodeAt(0) + 1)
    const oldTitle = match ? title : `${base} [A]`
    const newTitle = `${base} [${next}]`

    // 1. Export the whole conversation, before compaction shortens it.
    const messages = (await $.session.messages()).map(m => ({ ...m, text: clean(m.text) }))
    const body = messages
      .filter(m => m.text !== '' || m.toolUses.length > 0)
      .map(m => {
        const tools = m.toolUses.map(use => `  [tool] ${use.tool}`).join('\n')
        return `### ${m.role}\n${m.text}${tools === '' ? '' : `\n${tools}`}`
      })
      .join('\n\n')
    const fileName = oldTitle.replace(/[\\/:*?"<>|]/g, '_') + '.txt'
    const path = EXPORT_DIR + '\\' + fileName
    await $.fs.write(path, `${oldTitle}\n\n${body}\n`)
    await log($, 'export ok: ' + path)
    const pdf = await makePdf($, oldTitle, messages, EXPORT_DIR + '\\' + fileName.replace(/\.txt$/, '.pdf'))

    // 2. Summarise: $.session.compact is not available in the desktop app, so ask the model.
    await log($, 'summary start')
    const ask =
      'Schreibe eine Uebergabe fuer einen neuen Chat: Ziel, Stand, getroffene Entscheidungen, offene Punkte, wichtige Dateien und Pfade, naechste Schritte. Knapp, nur die Uebergabe.'
    let summary = ''
    try {
      const forked = await $.model.fork({ prompt: ask })
      if (forked.isAnswered) {
        summary = forked.text
      } else {
        await log($, 'fork failed: ' + forked.reason)
        const done = await $.model.complete({
          model: 'haiku',
          prompt: ask + '\n\nChat:\n' + body.slice(-60000),
        })
        summary = done.isAnswered ? done.text : ''
        await log($, 'complete answered: ' + done.isAnswered)
      }
    } catch (error) {
      await log($, 'summary error: ' + String(error))
    }
    if (summary === '') {
      summary = '(Keine Zusammenfassung moeglich, lies den vollen Verlauf in der Datei.)'
    }
    await log($, 'summary ok, ' + summary.length + ' chars')

    // 3. Rename, then clear; the handoff goes in once the cleared chat is up.
    await $.mcp.call(SESSIONS, 'set_session_title', { session_id: 'self', title: newTitle })
    pendingBack = { title: oldTitle, path, pdf }
    pendingHandoff =
      `Handoff aus dem vorherigen Chat "${oldTitle}" (voller Verlauf: ${path}):\n\n${summary}\n\n` +
      'Nutze diese Uebergabe als Kontext und mach bei der naechsten Nachricht genau da weiter.'
    await log($, 'title ok, clearing')
    let isCleared = false
    try {
      const cleared = await $.mcp.call(SESSIONS, 'clear_session', { session_id: 'self' })
      isCleared = !cleared.isError
      await log($, 'clear_session: ' + textOf(cleared).slice(0, 200))
    } catch (error) {
      await log($, 'clear_session refused: ' + String(error).slice(0, 300))
    }
    if (!isCleared) {
      await log($, 'fallback: running /clear')
      const ran = await $.command.run({ command: 'clear' })
      await log($, 'clear ran: ' + JSON.stringify(ran).slice(0, 200))
    }
  } catch (error) {
    isRunning = false
    await log($, 'error: ' + String(error))
    $.ui.toast(`Handoff fehlgeschlagen: ${String(error).slice(0, 200)}`)
  }
}

// Loads an exported chat into this one: hidden for the user, read by the model,
// plus a one-line notice so the user sees that it happened.
async function importChat($: Engine, path: string, title: string) {
  await resolvePaths($)
  try {
    const whole = String(await $.fs.read(path))
    const isCut = whole.length > IMPORT_MAX_CHARS
    const text = isCut ? whole.slice(-IMPORT_MAX_CHARS) : whole
    const appended = await $.session.append({
      message: {
        type: 'user',
        content: [{
          type: 'text',
          text:
            `Importierter Verlauf aus dem frueheren Chat "${title}" (Datei: ${path}` +
            (isCut ? ', nur das Ende, gekuerzt' : '') +
            '). Nutze ihn als Kontext fuer die naechsten Nachrichten:\n\n' + text,
        }],
      },
    })
    if ('deny' in appended && appended.deny !== undefined) {
      await log($, 'import denied: ' + appended.deny)
      $.ui.toast('Import abgelehnt: ' + appended.deny)
      return
    }
    await $.session.append({
      message: {
        type: 'system',
        content: [{
          type: 'text',
          text: `Verlauf von "${title}" geladen (${Math.round(text.length / 1000)}k Zeichen${isCut ? ', gekuerzt' : ''}).`,
        }],
      },
    })
    await log($, 'imported: ' + path + ' (' + text.length + ' chars)')
  } catch (error) {
    await log($, 'import failed: ' + String(error))
    $.ui.toast('Import fehlgeschlagen: ' + String(error).slice(0, 200))
  }
}

async function exportedChats($: Engine) {
  await resolvePaths($)
  const entries = await $.fs.list(EXPORT_DIR).catch(() => [])
  return entries
    .filter(entry => entry.kind === 'file' && entry.name.endsWith('.txt') && entry.name !== 'handoff-log.txt')
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

// The band's buttons, their dim hover hints, and what a press runs.
// A right click: on ⌾ picks the advisor's model, on C turns compact-when-idle on or off,
// on H switches between asking for a handover and the full handover.
type ButtonId = 'back' | 'advisor' | 'compact' | 'handover' | 'yes'
const BUTTONS: readonly string[] = ['back', 'advisor', 'compact', 'handover', 'yes']
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
type Model = (typeof MODELS)[number]
const MODEL_NAMES: Record<Model, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
let advisorModel: Model = 'opus'
let isPicking = false
let isFullHandover = false
let isLoaded = false
// The chat the advisor model and compact-when-idle were read for: both are set per chat.
let chatLoaded = ''

// Compact when idle: once a reply is done and nothing new comes for idleMinutes, the chat is
// compacted if its context is at least idlePercent full. The API's cache has run out by then,
// so the next message would read the whole chat anew anyway; compacted, it starts small.
// Both figures are settings (the settings pane), for every chat alike.
let idleMinutes = 10
let idlePercent = 50
let isIdleCompact = false
let isTurnRunning = false
let idleTimer: { cancel: () => void } | undefined

// The thumb's answer, typed into the chat as if the person had, in the language of the settings.
const LANGUAGES = ['en', 'es', 'zh', 'fr', 'uk', 'ja', 'ko', 'de'] as const
type Language = (typeof LANGUAGES)[number]
const LANGUAGE_NAMES: Record<Language, string> = {
  en: 'English', es: 'Español', fr: 'Français', uk: 'Українська',
  ja: '日本語', ko: '한국어', zh: '中文', de: 'Deutsch',
}
const YES: Record<Language, string> = {
  en: 'Yes, please', es: 'Sí, por favor', fr: "Oui, s'il te plaît", uk: 'Так, будь ласка',
  ja: 'はい、お願いします', ko: '네, 부탁해요', zh: '好的，麻烦了', de: 'Ja, bitte',
}
// Small flags for the language list: plain drawings, since Windows draws no flag emoji.
const FLAGS: Record<Language, string> = {
  en: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#012169"/><path d="M0 0L24 16M24 0L0 16" stroke="#fff" stroke-width="3.2"/><path d="M0 0L24 16M24 0L0 16" stroke="#C8102E" stroke-width="1.1"/><path d="M12 0V16M0 8H24" stroke="#fff" stroke-width="5"/><path d="M12 0V16M0 8H24" stroke="#C8102E" stroke-width="3"/></svg>',
  es: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#AA151B"/><rect y="4" width="24" height="8" fill="#F1BF00"/></svg>',
  fr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#fff"/><rect width="8" height="16" fill="#0055A4"/><rect x="16" width="8" height="16" fill="#EF4135"/><rect x="0.25" y="0.25" width="23.5" height="15.5" fill="none" stroke="#bbb" stroke-width="0.5"/></svg>',
  uk: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#FFD700"/><rect width="24" height="8" fill="#0057B7"/></svg>',
  ja: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#fff"/><circle cx="12" cy="8" r="4.8" fill="#BC002D"/><rect x="0.25" y="0.25" width="23.5" height="15.5" fill="none" stroke="#bbb" stroke-width="0.5"/></svg>',
  ko: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#fff"/><circle cx="12" cy="8" r="4" fill="#0047A0"/><path d="M8.67 5.78A4 4 0 0 1 15.33 10.22A2 2 0 0 1 12 8A2 2 0 0 0 8.67 5.78Z" fill="#CD2E3A"/><g transform="translate(5.2 3.6) rotate(-56)" fill="#000"><rect x="-1.6" y="-1.15" width="3.2" height="0.55"/><rect x="-1.6" y="-0.30" width="3.2" height="0.55"/><rect x="-1.6" y="0.55" width="3.2" height="0.55"/></g><g transform="translate(18.8 3.6) rotate(56)" fill="#000"><rect x="-1.6" y="-1.15" width="3.2" height="0.55"/><rect x="-1.6" y="-0.30" width="3.2" height="0.55"/><rect x="-1.6" y="0.55" width="3.2" height="0.55"/></g><g transform="translate(5.2 12.4) rotate(56)" fill="#000"><rect x="-1.6" y="-1.15" width="3.2" height="0.55"/><rect x="-1.6" y="-0.30" width="3.2" height="0.55"/><rect x="-1.6" y="0.55" width="3.2" height="0.55"/></g><g transform="translate(18.8 12.4) rotate(-56)" fill="#000"><rect x="-1.6" y="-1.15" width="3.2" height="0.55"/><rect x="-1.6" y="-0.30" width="3.2" height="0.55"/><rect x="-1.6" y="0.55" width="3.2" height="0.55"/></g><rect x="0.25" y="0.25" width="23.5" height="15.5" fill="none" stroke="#bbb" stroke-width="0.5"/></svg>',
  zh: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#EE1C25"/><path fill="#FFFF00" d="M4.00 1.60 L4.54 3.26 L6.28 3.26 L4.87 4.28 L5.41 5.94 L4.00 4.92 L2.59 5.94 L3.13 4.28 L1.72 3.26 L3.46 3.26ZM8.27 0.85 L8.25 1.43 L8.80 1.63 L8.24 1.79 L8.22 2.37 L7.90 1.89 L7.34 2.05 L7.69 1.59 L7.37 1.11 L7.92 1.31ZM10.17 2.63 L9.90 3.15 L10.31 3.56 L9.74 3.47 L9.47 3.99 L9.38 3.42 L8.81 3.33 L9.33 3.06 L9.24 2.49 L9.65 2.90ZM10.35 5.33 L9.89 5.68 L10.09 6.23 L9.61 5.91 L9.15 6.26 L9.31 5.70 L8.83 5.38 L9.41 5.36 L9.57 4.80 L9.77 5.35ZM8.27 6.45 L8.25 7.03 L8.80 7.23 L8.24 7.39 L8.22 7.97 L7.90 7.49 L7.34 7.65 L7.69 7.19 L7.37 6.71 L7.92 6.91Z"/></svg>',
  de: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><rect width="24" height="16" fill="#FFCE00"/><rect width="24" height="10.67" fill="#DD0000"/><rect width="24" height="5.33" fill="#000"/></svg>',
}
let language: Language = 'en'
let isChoosingLanguage = false
const yesText = () => YES[language]
// Compact when idle on: an outlined C in red in place of the plain one.
const C_RED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="#e5484d" stroke-width="1.3" stroke-linejoin="round" d="M18.16 6.34 A8 8 0 1 0 18.16 17.66 L15.75 15.25 A4.6 4.6 0 1 1 15.75 8.75 Z"/></svg>'
// A thumb up drawn as the bright-buttons hand is: a thin grey outline.
const THUMB =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="#9a9a9a" stroke-width="1.3" ' +
  'stroke-linecap="round" stroke-linejoin="round" d="M7.4 21.2 H15.6 A1.3 1.3 0 0 0 15.6 18.6 A1.3 1.3 0 0 0 15.6 16 A1.3 1.3 0 0 0 15.6 13.4 A1.3 1.3 0 0 0 15.6 10.8 H10.9 L11.6 6.6 C11.9 4.6 11.2 3.1 10 3.1 C9.1 3.1 8.8 3.9 8.6 5 C8.2 7.4 7.2 9.4 5.4 10.8 C4.8 11.3 4.5 12 4.5 12.8 V18.4 C4.5 20 5.8 21.2 7.4 21.2 Z"/></svg>'
const THUMB_DRAWN = 18
const C_DRAWN = 16

function hintText(id: ButtonId) {
  if (id === 'back') {
    return 'Previous chat (PDF)'
  }
  if (id === 'advisor') {
    return 'Advisor (' + MODEL_NAMES[advisorModel] + ')'
  }
  if (id === 'compact') {
    return isIdleCompact ? 'Compact (when idle)' : 'Compact'
  }
  if (id === 'yes') {
    return yesText()
  }
  return isFullHandover ? 'Full handover' : 'Handover'
}
let hint: ButtonId | undefined
// Whether the band's rows are laid side by side: then the hint stands at the band's left end,
// where bright-buttons shows a hovered file name, not beside these buttons.
let isCombined = false
// The room kept for the hint (columns), as bright-buttons keeps for its file name (its setting).
let hintRoom = 18
// Narrower than this (columns), the band leaves the thumb out first.
const THUMB_LEAST = 64
let lastIsWorking = false
let lastBack: Back | undefined
// Whether the band is wide enough for the thumb, as the list last measured it.
let isThumbShown = true

// The handover mode lasts from chat to chat; the advisor model and compact-when-idle belong to
// one chat each (a new chat starts with Opus and without compact-when-idle).
async function loadState($: Engine) {
  if (!isLoaded) {
    isLoaded = true
    isFullHandover = (await $.store.get('full-handover')) === true
    const minutes = Number(await $.store.get('idle-minutes'))
    const percent = Number(await $.store.get('idle-percent'))
    ownMinutes = Number.isFinite(minutes) && minutes >= 1 ? minutes : 10
    ownPercent = Number.isFinite(percent) && percent >= 1 && percent <= 100 ? percent : 50
    const stored = (await $.store.get('language')) as Language | undefined
    ownLanguage = stored !== undefined && LANGUAGES.includes(stored) ? stored : 'en'
    idleMinutes = ownMinutes
    idlePercent = ownPercent
    language = ownLanguage
  }
  const id = await $.session.id()
  if (chatLoaded === id) {
    return
  }
  chatLoaded = id
  const model = (await $.store.get('advisor-model:' + id)) as Model | undefined
  advisorModel = model !== undefined && MODELS.includes(model) ? model : 'opus'
  const wasIdle = isIdleCompact
  isIdleCompact = (await $.store.get('idle-compact:' + id)) === true
  if (wasIdle && !isIdleCompact) {
    stopIdle()
  }
}

// With bright-buttons, its settings pane holds these settings too: handoff-button hands it its own
// values and languages, and takes the values set there ($.state, for the session).
const SHARED = { plugin: 'bright-buttons', key: 'shared' } as const
const OWN = { plugin: 'handoff-button', key: 'settings' } as const
let ownMinutes = 10
let ownPercent = 50
let ownLanguage: Language = 'en'
let isPublished = false
let isBrightHere = false

async function publish($: Engine) {
  isPublished = true
  try {
    await $.state.set(OWN, {
      idleMinutes: ownMinutes,
      idlePercent: ownPercent,
      language: ownLanguage,
      languages: LANGUAGES.map(id => ({ id, name: LANGUAGE_NAMES[id], flag: FLAGS[id], yes: YES[id] })),
    })
  } catch {
    isPublished = false
  }
}

// The values in force: bright-buttons' where it set them, else our own.
async function readShared($: Engine) {
  let shared: { textRoom?: number; idleMinutes?: number; idlePercent?: number; language?: string } | undefined
  try {
    const read = await $.state.get(SHARED)
    shared = read.version > 0 ? read.value : undefined
  } catch {
    shared = undefined
  }
  isBrightHere = shared !== undefined
  const lang = shared?.language as Language | undefined
  idleMinutes = shared?.idleMinutes ?? ownMinutes
  idlePercent = shared?.idlePercent ?? ownPercent
  language = lang !== undefined && LANGUAGES.includes(lang) ? lang : ownLanguage
  hintRoom = shared?.textRoom ?? 18
}

// The settings open in bright-buttons' pane when it runs, else in our own.
function openSettings($: Engine) {
  $.clock.after(0, async () => {
    await readShared($)
    if (isBrightHere) {
      try {
        await $.command.run({ command: 'bright-buttons' })
        return
      } catch (error) {
        await log($, 'bright-buttons settings: ' + String(error))
      }
    }
    await $.ui.open({ id: SETTINGS_PANE, title: 'Handoff buttons' })
  })
}

function stopIdle() {
  idleTimer?.cancel()
  idleTimer = undefined
}

function startIdle($: Engine) {
  stopIdle()
  if (!isIdleCompact) {
    return
  }
  idleTimer = $.clock.after(idleMinutes * 60 * 1000, async () => {
    idleTimer = undefined
    if (!isIdleCompact || isTurnRunning || isRunning) {
      return
    }
    try {
      await readShared($)
      const { context } = await $.session.usage()
      const percent = context.percent ?? (context.tokens === undefined ? 0 : Math.round(100 * context.tokens / context.window))
      await log($, 'idle check: context ' + percent + '%')
      if (percent >= idlePercent) {
        await compact($)
      }
    } catch (error) {
      await log($, 'idle compact error: ' + String(error))
    }
  }) as { cancel: () => void }
}

async function toggleIdleCompact($: Engine) {
  isIdleCompact = !isIdleCompact
  await $.store.set('idle-compact:' + (await $.session.id()), isIdleCompact)
  await log($, 'compact when idle: ' + isIdleCompact)
  if (isIdleCompact && !isTurnRunning) {
    startIdle($)
  } else if (!isIdleCompact) {
    stopIdle()
  }
}

async function sayYes($: Engine) {
  await readShared($)
  try {
    await $.prompt.submit({ text: yesText(), asUser: true })
  } catch (error) {
    $.ui.toast('Senden ging nicht: ' + String(error).slice(0, 200))
  }
}

async function saveIdle($: Engine, field: 'minutes' | 'percent', text: string) {
  const value = Math.round(Number(text.trim()))
  const isOk = field === 'minutes' ? value >= 1 && value <= 600 : value >= 1 && value <= 100
  if (!Number.isFinite(value) || !isOk) {
    $.ui.toast(field === 'minutes' ? 'Minutes: 1 to 600.' : 'Percent: 1 to 100.')
    return
  }
  if (field === 'minutes') {
    ownMinutes = value
    idleMinutes = value
    await $.store.set('idle-minutes', value)
    if (idleTimer !== undefined) {
      startIdle($)
    }
  } else {
    ownPercent = value
    idlePercent = value
    await $.store.set('idle-percent', value)
  }
  await publish($)
  $.ui.invalidate('ui.render')
}

async function chooseLanguage($: Engine, next: Language) {
  language = next
  ownLanguage = next
  isChoosingLanguage = false
  await $.store.set('language', next)
  await publish($)
  $.ui.invalidate('ui.render')
}

// The settings of these buttons: compact when idle and the language, a list of small flags.
function settingsOf($: Engine, ui: any) {
  const { Box, Text, Input, Button, Svg } = ui
  const flag = (lang: Language) => Svg === undefined
    ? undefined
    : <Svg key={'flag-' + lang} source={FLAGS[lang]} alt={LANGUAGE_NAMES[lang]} width={21} height={14} />
  return (
    <Box key="handoff-settings" flexDirection="column" gap="sm">
      <Text bold>Handoff buttons</Text>
      <Text dimColor>Compact when idle (right click on C, per chat): after a reply, with nothing new for this long, the chat is compacted if its context is this full. Enter saves.</Text>
      <Input
        key="idleMinutes"
        label="Minutes: "
        value={String(idleMinutes)}
        submitLabel="save"
        onSubmit={(value: string) => void saveIdle($, 'minutes', value)}
      />
      <Input
        key="idlePercent"
        label="Context at least (%): "
        value={String(idlePercent)}
        submitLabel="save"
        onSubmit={(value: string) => void saveIdle($, 'percent', value)}
      />
      <Text dimColor>Language: for now, what the thumb sends.</Text>
      <Box key="language-now" flexDirection="row" alignItems="center" gap="sm">
        {flag(language)}
        <Button key="language-open" plain label={LANGUAGE_NAMES[language] + (isChoosingLanguage ? '  ▴' : '  ▾')} onPress={() => {
          isChoosingLanguage = !isChoosingLanguage
          $.ui.invalidate('ui.render')
        }} />
      </Box>
      {isChoosingLanguage && LANGUAGES.map(lang => (
        <Box key={'language-' + lang} flexDirection="row" alignItems="center" gap="sm" marginLeft="md">
          {flag(lang)}
          <Button key={'pick-' + lang} plain dimColor={lang !== language} label={LANGUAGE_NAMES[lang]} onPress={() => {
            $.clock.after(0, () => void chooseLanguage($, lang))
          }} />
        </Box>
      ))}
      <Text dimColor>{'The thumb sends: ' + yesText()}</Text>
    </Box>
  )
}

// One of the band's buttons. Each keeps its look (a drawing where it has one); an invisible region
// of hover.tsx over it shows a dim hint while the pointer is on it and runs the action on a click.
// Without regions, plain buttons.
// A drawing on a button (the red C) keeps the button's grey field: the button stands under it with a
// blank label of a letter's width, the drawing centred on top.
function buttonOf($: Engine, ui: any, id: ButtonId, label: string, drawing?: string, isOnField = false) {
  const { Box, Button, Svg, Client } = ui
  const isDrawn = drawing !== undefined && Svg !== undefined && Client !== undefined
  const press = () => {
    $.clock.after(0, () => void pressButton($, id))
  }
  return (
    <Box key={'wrap-' + id} position="relative" flexShrink={0}>
      {isDrawn && !isOnField ? (
        <Svg key={'look-' + id} source={drawing} alt={label} width={THUMB_DRAWN} height={THUMB_DRAWN} />
      ) : (
        <Button key={id} label={isDrawn ? ' ' : label} dimColor onPress={press} />
      )}
      {isDrawn && isOnField && (
        <Box key={'field-' + id} position="absolute" top={0} left={0} right={0} bottom={0} alignItems="center" justifyContent="center">
          <Svg key={'look-' + id} source={drawing} alt={label} width={C_DRAWN} height={C_DRAWN} />
        </Box>
      )}
      {Client !== undefined && (
        <Box position="absolute" top={0} left={0} right={0} bottom={0}>
          <Client key={'hover-' + id} module="./hover.tsx" props={{ id }} width="100%" height="100%" />
        </Box>
      )}
    </Box>
  )
}

async function pickModel($: Engine, model: Model) {
  isPicking = false
  advisorModel = model
  await $.store.set('advisor-model:' + (await $.session.id()), model)
  $.ui.invalidate('ui.render')
  await advisor($)
}

async function rightClick($: Engine, id: ButtonId) {
  if (id === 'advisor') {
    isPicking = !isPicking
  } else if (id === 'compact') {
    await toggleIdleCompact($)
  } else if (id === 'handover') {
    isFullHandover = !isFullHandover
    await $.store.set('full-handover', isFullHandover)
  } else if (id === 'yes') {
    // A right click on the thumb opens the settings.
    openSettings($)
  }
  $.ui.invalidate('ui.render')
}

async function pressButton($: Engine, id: ButtonId) {
  if (id === 'back') {
    if (lastBack !== undefined) {
      await openPdf($, lastBack)
    }
  } else if (id === 'advisor') {
    await advisor($)
  } else if (id === 'compact') {
    await compact($)
  } else if (id === 'yes') {
    await sayYes($)
  } else if (isFullHandover) {
    await handoff($, lastIsWorking)
  } else {
    await askHandover($)
  }
}

// The dim hint, one line: cut with an ellipsis when the band is short of room.
// Beside bright-buttons' row it takes all the free room, so it starts at the band's left end.
// Without a hint it keeps no room: bright-buttons' hovered name takes it, and the thumb stays.
function hintOf(Box: any, Text: any, fill = false) {
  return (
    <Box key="hint" marginRight={hint === undefined ? undefined : 'md'} flexGrow={fill ? 1 : 0} flexShrink={1} minWidth={hint === undefined ? 0 : hintRoom}>
      <Text dimColor wrap="truncate-end">{hint === undefined ? '' : hintText(hint)}</Text>
    </Box>
  )
}

export const register: Register = on => {
  // The hover regions (hover.tsx) post the pointer coming and going, a left and a right click.
  on('ui.message', async ($, e) => {
    const data = (e as any).data as { action?: string; id?: string } | undefined
    const id = data?.id as ButtonId | undefined
    if (id === undefined || !BUTTONS.includes(id)) {
      return {}
    }
    if (data?.action === 'press') {
      $.clock.after(0, () => void pressButton($, id))
    } else if (data?.action === 'menu') {
      $.clock.after(0, () => void rightClick($, id))
    } else if (data?.action === 'enter' || data?.action === 'leave') {
      const next = data.action === 'enter' ? id : hint === id ? undefined : hint
      if (next !== hint) {
        hint = next
        $.ui.invalidate('ui.render')
      }
    }
    return {}
  })

  // Compact when idle: the timer runs from the end of the main chat's reply to the next one.
  on('turn.start', async ($, e, next) => {
    if ((e as any).agentId === undefined) {
      isTurnRunning = true
      stopIdle()
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if ((e as any).agentId === undefined) {
      isTurnRunning = false
      await loadState($)
      await readShared($)
      startIdle($)
    }
    return next(e)
  })

  // /handoff-button and a right click on the thumb open the settings: bright-buttons' pane, which
  // holds them too, when it runs (a pane belongs to one mod), else this mod's own.
  on('command.run', { command: 'handoff-button' }, async $ => {
    await loadState($)
    openSettings($)
    return { text: 'Handoff buttons settings opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    await loadState($)
    return settingsOf($, $.ui.resolve(e))
  })

  on('session.start', async ($, e, next) => {
    try {
      await loadState($)
      await publish($)
    } catch (error) {
      await log($, 'publish settings: ' + String(error))
    }
    await $.command.register({
      name: 'handoff-button',
      description: 'Settings of the handoff buttons: compact when idle, language',
    })
    await $.command.register({
      name: 'import-chat',
      description: 'Einen exportierten Chat aus "Claude Handoffs" in diesen Chat laden',
      argumentHint: '[Nummer oder Name]',
    })

    return next(e)
  })

  on('command.run', { command: 'import-chat' }, async ($, e) => {
    const wanted = (e.args ?? '').trim()
    if (wanted === '') {
      await $.ui.open({ id: IMPORT_PANE, title: 'Chat importieren' })
      return { text: 'Waehle rechts einen exportierten Chat.' }
    }

    const files = await exportedChats($)
    const index = Number(wanted)
    const file = Number.isInteger(index) && index >= 1
      ? files[index - 1]
      : files.find(entry => entry.name.toLowerCase().includes(wanted.toLowerCase()))
    if (file === undefined) {
      return { text: `Kein exportierter Chat passt zu "${wanted}".` }
    }
    await importChat($, EXPORT_DIR + '\\' + file.name, file.name.replace(/\.txt$/, ''))

    return { text: `"${file.name}" importiert.` }
  })

  on('ui.render', { component: 'Pane', requestId: IMPORT_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const files = await exportedChats($)

    return (
      <Box flexDirection="column">
        {files.length === 0 && <Text dimColor>Noch keine exportierten Chats.</Text>}
        {files.map((file, i) => (
          <Button
            key={'import-' + i}
            label={file.name.replace(/\.txt$/, '')}
            plain
            onPress={() => {
              void $.ui.close({ id: IMPORT_PANE })
              $.clock.after(0, () => void importChat($, EXPORT_DIR + '\\' + file.name, file.name.replace(/\.txt$/, '')))
            }}
          />
        ))}
      </Box>
    )
  })

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear' && pendingHandoff !== undefined) {
      const text = pendingHandoff
      const back = pendingBack === undefined ? undefined : { ...pendingBack, id: e.sessionId }
      pendingHandoff = undefined
      pendingBack = undefined
      $.clock.after(AFTER_CLEAR_MS, async () => {
        isRunning = false
        if (back !== undefined) {
          const newId = await $.session.id()
          await $.store.set('back:' + newId, back)
          await log($, 'back link: ' + newId + ' -> ' + back.id)
          $.ui.invalidate('ui.render')
        }
        // A user row the model reads but the chat does not show as a message.
        const appended = await $.session.append({
          message: { type: 'user', content: [{ type: 'text', text }] },
        })
        if ('deny' in appended && appended.deny !== undefined) {
          await log($, 'append denied: ' + appended.deny + ', submitting instead')
          void $.prompt.submit({ text })
        } else {
          await log($, 'handoff appended')
        }
      })
    }

    return next(e)
  })

  // Since the app draws one band row per mod, the rows are laid side by side again:
  // bright-buttons first, these buttons last, all on one line at the right.
  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    const rank = (plugin: string) => (plugin.includes('bright-buttons') || plugin.includes('path-buttons') ? 0 : plugin.includes('handoff-button') ? 2 : 1)
    // While the advisor's models are shown, the band holds them alone.
    const rows = [...e.props.rows]
      .filter(row => !isPicking || row.plugin.includes('handoff-button'))
      .sort((a, b) => rank(a.plugin) - rank(b.plugin))
    isThumbShown = !isPicking && e.props.bodyColumns >= THUMB_LEAST
    // Each row drawn on its own by the engine, then the drawn rows side by side in one Box.
    if (e.props.hasSurvey || rows.length < 2) {
      isCombined = false
      return next({ ...e, props: { ...e.props, rows } })
    }
    isCombined = true
    const drawn: any[] = []
    for (const row of rows) {
      drawn.push(await next({ ...e, props: { ...e.props, rows: [row] } }))
    }
    const ui = $.ui.resolve(e) as any
    // The thumb at the band's left end, the hint right of it, where bright-buttons shows a hovered
    // file name. Nothing wraps the rows: a wrapper counts toward the band's limits, past them it is blank.
    return (
      <ui.Box flexDirection="row" justifyContent="flex-end" alignItems="center" gap="sm">
        {isThumbShown && buttonOf($, ui, 'yes', '👍', THUMB)}
        {(isThumbShown || hint !== undefined) && hintOf(ui.Box, ui.Text, true)}
        {drawn}
      </ui.Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    // Other mods (bright-buttons) may add their own row content; it sits left of H.
    const others = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    const id = await $.session.id()
    if (backFor !== id) {
      backFor = id
      backTo = (await $.store.get('back:' + id)) as typeof backTo
    }
    const back = backTo

    await loadState($)
    await readShared($)
    if (!isPublished) {
      isPublished = true
      $.clock.after(0, () => void publish($))
    }
    lastIsWorking = e.props.isWorking
    lastBack = back
    const ui = $.ui.resolve(e) as any
    const button = (id: ButtonId, label: string, drawing?: string) => buttonOf($, ui, id, label, drawing)
    // Alone in the band (no other mod's row), the thumb and the hint stand here, at the left end.
    const isAlone = !isCombined
    const isThumbHere = isAlone && !isPicking && e.props.bodyColumns >= THUMB_LEAST

    return (
      <Box justifyContent="flex-end" alignItems="center" gap="sm">
        {isThumbHere && button('yes', '👍', THUMB)}
        {isAlone && (isThumbHere || hint !== undefined) && hintOf(Box, ui.Text, isThumbHere)}
        {!isPicking && others.type !== 'engine' && others}
        {!isPicking && back !== undefined && button('back', '<<')}
        {/* After a right click on ⌾ the models stand left of it, the other buttons out of the way;
            the chosen model at full strength. */}
        {isPicking && MODELS.map(model => (
          <Button key={'model-' + model} label={MODEL_NAMES[model]} plain dimColor={model !== advisorModel} onPress={() => {
            $.clock.after(0, () => void pickModel($, model))
          }} />
        ))}
        {button('advisor', '⌾')}
        {/* Compact when idle on: an outlined C in red. */}
        {!isPicking && buttonOf($, ui, 'compact', 'C', isIdleCompact ? C_RED : undefined, true)}
        {/* Full handover mode: ⤓ in place of H. */}
        {!isPicking && button('handover', isFullHandover ? '⤓' : 'H')}
      </Box>
    )
  })
}