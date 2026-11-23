import type { EngineInterface as Engine, Register } from 'claude-code'

// ---- The thumb, ⌾, C and H (formerly the handoff-button mod) ----
// The thumb, ⌾ (advisor), C (compact, with the cache's hourglass) and H (handover). The path buttons
// below draw the band and the settings pane; cfg holds what the settings decide for these buttons.

const SESSIONS = 'ccd_session_mgmt'
const VERSION = /\s\[([A-Z])\]\s*$/
const AFTER_CLEAR_MS = 2000
const IMPORT_MAX_CHARS = 200000
const IMPORT_PANE = 'import-chat'
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
const cleanRow = (text: string) =>
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
    const messages = (await $.session.messages()).map(m => ({ ...m, text: cleanRow(m.text) }))
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
// ⌾ runs /advisor (a right click picks its model). The cache button shows the prompt cache's time
// left (a click renews it now, a right click turns auto-renew on or off). The context button shows the
// context still free and runs its mode: compact, handover, or handover with log and clear (a right
// click shows the modes and the compact-when-idle switch). The ids 'compact' and 'handover' stay
// those of the cache and the context button, as the stored settings name them.
type ButtonId = 'back' | 'advisor' | 'custom' | 'compact' | 'handover' | 'yes' | 'idle'
const BUTTONS: readonly string[] = ['back', 'advisor', 'custom', 'compact', 'handover', 'yes', 'idle']
const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const
type Model = (typeof MODELS)[number]
const MODEL_NAMES: Record<Model, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
let advisorModel: Model = 'opus'
let isPicking = false
let isLoaded = false
// The chat the advisor model, compact-when-idle and auto-renew were read for: all are set per chat.
let chatLoaded = ''

// What the context button runs, from chat to chat.
const CONTEXT_MODES = ['compact', 'handover', 'full'] as const
type ContextMode = (typeof CONTEXT_MODES)[number]
const CONTEXT_MODE_NAMES: Record<ContextMode, string> = { compact: 'Compact', handover: 'Handover', full: 'Handover, Log & Clear' }
let contextMode: ContextMode = 'handover'
let isContextMenu = false

// Compact when idle (per chat): once a reply is done and nothing new comes for idleMinutes, the chat
// is compacted if its context is at least idlePercent full. A red dot on the context button.
// Auto-renew (per chat): renewLead minutes before the cache's time is up, a short message keeps the
// cache alive, renewMax times in a row at most (a message of the person's counts again from 0).
// A red dot on the cache button.
let isIdleCompact = false
let isAutoRenew = false
let isTurnRunning = false
let idleTimer: { cancel: () => void } | undefined
let renewTimer: { cancel: () => void } | undefined
let renewCount = 0
let isRenewSent = false
const RENEW_TEXT = 'Cache keep-alive, nothing to do. Reply with just: ok'

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
const yesText = () => cfg.thumbText.trim() || YES[cfg.language]

// What the settings decide: which buttons show, the idle and cache figures, the language, the
// thumb's own text (in that language), the advisor model a new chat starts with, the room for the hint.
type HandoffConfig = {
  thumb: boolean
  advisor: boolean
  compact: boolean
  handover: boolean
  idleMinutes: number
  idlePercent: number
  cacheMinutes: number
  renewLead: number
  renewMax: number
  language: Language
  advisorModel: Model
  textRoom: number
  thumbText: string
}
const cfg: HandoffConfig = {
  thumb: true,
  advisor: false,
  compact: true,
  handover: true,
  idleMinutes: 55,
  idlePercent: 50,
  cacheMinutes: 60,
  renewLead: 1,
  renewMax: 2,
  language: 'en',
  advisorModel: 'opus',
  textRoom: 10,
  thumbText: '',
}
// A thumb up drawn as the bright-buttons hand is: a thin grey outline.
const THUMB =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="#9a9a9a" stroke-width="1.3" ' +
  'stroke-linecap="round" stroke-linejoin="round" d="M7.4 21.2 H15.6 A1.3 1.3 0 0 0 15.6 18.6 A1.3 1.3 0 0 0 15.6 16 A1.3 1.3 0 0 0 15.6 13.4 A1.3 1.3 0 0 0 15.6 10.8 H10.9 L11.6 6.6 C11.9 4.6 11.2 3.1 10 3.1 C9.1 3.1 8.8 3.9 8.6 5 C8.2 7.4 7.2 9.4 5.4 10.8 C4.8 11.3 4.5 12 4.5 12.8 V18.4 C4.5 20 5.8 21.2 7.4 21.2 Z"/></svg>'
const THUMB_SIZE = 18
const C_DRAWN = 16

function hintText(id: ButtonId) {
  if (id === 'back') {
    return 'Previous chat (PDF)'
  }
  if (id === 'advisor') {
    return 'Advisor (' + MODEL_NAMES[advisorModel] + ')'
  }
  if (id === 'compact') {
    return 'Cache' + (minutesShown > 0 ? ' · ' + minutesShown + ' min' : isExpiredShown ? ' · expired' : '') +
      (isAutoRenew ? (renewCount > 0 ? ' · auto-renewed ' + renewCount + '×' : ' · auto-renew on') : '')
  }
  if (id === 'custom') {
    return (settings.customName.trim() || 'Custom button') + (isCustomStarting ? ' · starting…' : '') +
      (settings.customOpen.trim() === '' && settings.customStart.trim() === '' ? ' · set it up in the settings' : '')
  }
  if (id === 'idle') {
    return 'Compact when idle: ' + cfg.idleMinutes + ' min, context ≥ ' + cfg.idlePercent + ' %'
  }
  if (id === 'yes') {
    return yesText()
  }
  const context = contextOf.get(chatLoaded)
  return CONTEXT_MODE_NAMES[contextMode] + (context !== undefined && context > 0 ? ' · context ' + context + ' %' : '') +
    (isIdleCompact ? ' · compact when idle' : '')
}
let hint: ButtonId | undefined
// Narrower than this (columns), the band leaves the thumb out first.
const THUMB_LEAST = 64
let lastIsWorking = false
let lastBack: Back | undefined
// Whether the thumb shows in a band this many columns wide.
const thumbFits = (columns: number) => cfg.thumb && !isPicking && !isContextMenu && columns >= THUMB_LEAST

// The context mode lasts from chat to chat; the advisor model, compact-when-idle and auto-renew belong
// to one chat each (a new chat starts with the settings' advisor model, both of the others off).
async function loadState($: Engine) {
  if (!isLoaded) {
    isLoaded = true
    const mode = (await $.store.get('context-mode')) as ContextMode | undefined
    contextMode = mode !== undefined && CONTEXT_MODES.includes(mode)
      ? mode
      : (await $.store.get('full-handover')) === true ? 'full' : 'handover'
  }
  const id = await $.session.id()
  if (chatLoaded === id) {
    return
  }
  chatLoaded = id
  const model = (await $.store.get('advisor-model:' + id)) as Model | undefined
  advisorModel = model !== undefined && MODELS.includes(model) ? model : cfg.advisorModel
  // Before 0.14 one mode of C held either: read it where the new keys are not set yet.
  const old = await $.store.get('c-mode:' + id)
  const idle = await $.store.get('idle-compact:' + id)
  const renew = await $.store.get('auto-renew:' + id)
  isIdleCompact = idle === true || (idle === undefined && old === 'idle')
  isAutoRenew = renew === true || (renew === undefined && old === 'renew')
  renewCount = 0
  // Another chat: its own waits.
  if (!isTurnRunning) {
    startIdle($)
  } else {
    stopIdle()
  }
}

// How long the prompt cache still holds: it lasts an hour from the end of the chat's last reply.
// One timer a minute draws the cache button again while any time is left.
const cacheFrom = new Map<string, number>()
let isTicking = false

function tick($: Engine) {
  if (isTicking) {
    return
  }
  isTicking = true
  $.clock.after(60 * 1000, async () => {
    isTicking = false
    $.ui.invalidate('ui.render')
    const now = await $.clock.now()
    if ([...cacheFrom.values()].some(from => now - from < cfg.cacheMinutes * 60000)) {
      tick($)
    }
  })
}

// When the chat's last reply ended, from its transcript (~/.claude/projects/<folder>/<id>.jsonl): for a
// chat whose last reply came before the store kept it (a new install, a reload mid-turn). 0 when unknown.
async function lastReplyAt($: Engine, id: string) {
  try {
    await resolvePlatform($)
    if (home === '') {
      return 0
    }
    const sep = sepOf(home)
    const root = home + sep + '.claude' + sep + 'projects'
    for (const folder of (await $.fs.list(root)).filter(entry => entry.kind === 'dir')) {
      const file = root + sep + folder.name + sep + id + '.jsonl'
      if (!(await $.fs.exists(file))) {
        continue
      }
      // The newest assistant row: the transcript is written in order, so it is the last one.
      const rows = String(await $.fs.read(file)).slice(-400000).split('\n').reverse()
      for (const row of rows) {
        const at = row.includes('"type":"assistant"') ? /"timestamp":"([^"]+)"/.exec(row)?.[1] : undefined
        const time = at === undefined ? NaN : Date.parse(at)
        if (Number.isFinite(time)) {
          return time
        }
      }
      return 0
    }
  } catch {
    // no transcript: the field stays empty until the next reply
  }
  return 0
}

async function cacheLeft($: Engine, id: string) {
  if (!cacheFrom.has(id)) {
    const stored = Number(await $.store.get('cache-from:' + id))
    cacheFrom.set(id, Number.isFinite(stored) && stored > 0 ? stored : await lastReplyAt($, id))
  }
  const left = (cacheFrom.get(id) ?? 0) + cfg.cacheMinutes * 60000 - (await $.clock.now())
  return left > 0 ? Math.ceil(left / 60000) : 0
}

// The cache and the context button are one drawing each, on a field the size of the app's buttons
// (H: 30 x 28, light theme): a thin frame, a grey fill, a small symbol, a red dot top right while
// their automatic (auto-renew, compact when idle) is on.
// Cache: the time still left fills the field from the bottom, an abstract hourglass; run out, the
// symbol turns pale with a small "zz" (the cache sleeps). The symbol: an ice lolly in hairlines.
// Context: the context still free fills the field from the bottom (its top sinks as the chat grows);
// its letter (the mode) takes a colour once the context is this full (percent).
const C_FIELD_W = 30
const C_FIELD_H = 28
const C_FIELD_R = 6
const C_FIELD_GREY = '#e7e7e7'
const C_LETTER_GREY = '#5c5c5c'
const C_PALE_GREY = '#cfcfcf'
const C_ZZ_GREY = '#b5b5b5'
const C_DOT_RED = '#e5484d'
const H_STEPS: readonly (readonly [number, string])[] = [[75, '#e5484d'], [50, '#f08c00'], [33, '#3e7bd6'], [20, '#30a46c']]

function fieldOf(id: string, filled: number, symbol: string, isDot: boolean) {
  const w = C_FIELD_W
  const h = C_FIELD_H
  const share = Math.max(0, Math.min(1, filled))
  const top = (h * (1 - share)).toFixed(2)
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<defs><clipPath id="' + id + '"><rect width="' + w + '" height="' + h + '" rx="' + C_FIELD_R + '"/></clipPath></defs>' +
    (share > 0 ? '<rect y="' + top + '" width="' + w + '" height="' + h + '" fill="' + C_FIELD_GREY + '" clip-path="url(#' + id + ')"/>' : '') +
    '<rect x="0.5" y="0.5" width="' + (w - 1) + '" height="' + (h - 1) + '" rx="' + (C_FIELD_R - 0.5) + '" fill="none" stroke="' +
    C_FIELD_GREY + '" stroke-width="1"/>' + symbol +
    (isDot ? '<circle cx="' + (w - 4.6) + '" cy="4.6" r="2.7" fill="' + C_DOT_RED + '" stroke="#fff" stroke-width="0.8"/>' : '') +
    '</svg>'
}

function cacheField(minutes: number, isRenew: boolean, isExpired: boolean) {
  const x = isExpired ? 13 : 15
  const colour = isExpired ? C_PALE_GREY : C_LETTER_GREY
  // An ice lolly in hairlines: rounded top, the glaze running down with a long drip, the stick, a
  // glint top right (drawn on 24 x 24, scaled in; centred on x).
  const symbol = '<g transform="translate(' + (x - 12.75) + ' 0.6) scale(1.0625)" fill="none" stroke="' + colour + '" stroke-width="0.72" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6.6 16.2V8A5.4 5.4 0 0 1 17.4 8V16.2A1 1 0 0 1 16.4 17.2H7.6A1 1 0 0 1 6.6 16.2Z"/>' +
    '<path d="M6.6 10.4C7.2 11.3 8.3 11.2 8.8 10.5C9.4 9.6 10.3 9.6 10.8 10.3' +
    'C11.5 10.9 12 10.5 12.2 11V14.6A0.9 0.9 0 0 0 14 14.6V10.8C14.2 9.9 15 9.8 15.5 10.4C16 11 16.9 10.8 17.4 9.8"/>' +
    '<path d="M10.8 17.2V21.4A1.2 1.2 0 0 0 13.2 21.4V17.2"/>' +
    '<path d="M14.6 3.6A4.6 4.6 0 0 1 16.8 6.2M16.9 7V7.6"/></g>' +
    (isExpired
      ? '<text x="' + (C_FIELD_W - 8.5) + '" y="9.5" font-family="Segoe UI, system-ui, sans-serif" font-style="italic" font-size="5.5" fill="' + C_ZZ_GREY + '">z</text>' +
        '<text x="' + (C_FIELD_W - 6) + '" y="6.2" font-family="Segoe UI, system-ui, sans-serif" font-style="italic" font-size="4" fill="' + C_PALE_GREY + '">z</text>'
      : '')
  const left = Math.max(0, Math.min(cfg.cacheMinutes, minutes)) / cfg.cacheMinutes
  // With the "zz" top right the dot would sit on it: it moves to the bottom right then.
  const svg = fieldOf('cachefield', left, symbol, isRenew && !isExpired)
  return isRenew && isExpired
    ? svg.replace('</svg>', '<circle cx="' + (C_FIELD_W - 4.6) + '" cy="' + (C_FIELD_H - 4.6) + '" r="2.7" fill="' + C_DOT_RED + '" stroke="#fff" stroke-width="0.8"/></svg>')
    : svg
}

// The context button's letter names its mode: C (compact), H (handover), ⤓ (handover, log & clear).
const CONTEXT_LETTERS: Record<ContextMode, string> = { compact: 'C', handover: 'H', full: '⤓' }
function contextField(contextPercent: number, isIdle: boolean, mode: ContextMode) {
  const colour = H_STEPS.find(([least]) => contextPercent >= least)?.[1] ?? C_LETTER_GREY
  const symbol = '<text x="' + (C_FIELD_W / 2) + '" y="' + (C_FIELD_H / 2) + '" text-anchor="middle" dominant-baseline="central" ' +
    'font-family="Segoe UI, system-ui, -apple-system, sans-serif" font-size="14" fill="' + colour + '">' + CONTEXT_LETTERS[mode] + '</text>'
  return fieldOf('contextfield', 1 - contextPercent / 100, symbol, isIdle)
}

let minutesShown = 0
let isExpiredShown = false
// How full the context is (percent) per chat, read after each reply and the first time a chat shows.
const contextOf = new Map<string, number>()
async function readContext($: Engine, id: string) {
  try {
    const { context } = await $.session.usage()
    const percent = context.percent ?? (context.tokens === undefined ? 0 : Math.round(100 * context.tokens / context.window))
    if (contextOf.get(id) !== percent) {
      contextOf.set(id, percent)
      $.ui.invalidate('ui.render')
    }
  } catch {
    // no figures: a full field
  }
}

// Both waits stop when a turn starts and start again when one ends (or another chat shows).
function stopIdle() {
  idleTimer?.cancel()
  idleTimer = undefined
  renewTimer?.cancel()
  renewTimer = undefined
}

function startIdle($: Engine) {
  stopIdle()
  if (isAutoRenew) {
    void startRenew($)
  }
  if (!isIdleCompact) {
    return
  }
  idleTimer = $.clock.after(cfg.idleMinutes * 60 * 1000, async () => {
    idleTimer = undefined
    if (!isIdleCompact || isTurnRunning || isRunning) {
      return
    }
    try {
      const { context } = await $.session.usage()
      const percent = context.percent ?? (context.tokens === undefined ? 0 : Math.round(100 * context.tokens / context.window))
      await log($, 'idle check: context ' + percent + '%')
      if (percent >= cfg.idlePercent) {
        await compact($)
      }
    } catch (error) {
      await log($, 'idle compact error: ' + String(error))
    }
  }) as { cancel: () => void }
}

// Auto-renew: renewLead minutes before the cache's time (from the end of the last reply) is up, a
// short message as the plugin's own keeps the cache alive. Only in the chat it was set for.
async function startRenew($: Engine) {
  const id = await $.session.id()
  await cacheLeft($, id)
  const from = cacheFrom.get(id) ?? 0
  if (from <= 0 || !isAutoRenew || isTurnRunning) {
    return
  }
  if (renewCount >= cfg.renewMax) {
    await log($, 'auto-renew: ' + renewCount + ' in a row, stopped')
    return
  }
  const wait = from + Math.max(1, cfg.cacheMinutes - cfg.renewLead) * 60000 - (await $.clock.now())
  if (wait <= 0) {
    // The cache is gone already (or about to be): renewing would write it anew.
    return
  }
  renewTimer?.cancel()
  renewTimer = $.clock.after(wait, async () => {
    renewTimer = undefined
    if (!isAutoRenew || isTurnRunning || isRunning || (await $.session.id()) !== id) {
      return
    }
    renewCount++
    isRenewSent = true
    await log($, 'auto-renew ' + renewCount + '/' + cfg.renewMax)
    try {
      await $.prompt.submit({ text: RENEW_TEXT })
    } catch (error) {
      isRenewSent = false
      await log($, 'auto-renew error: ' + String(error))
    }
  }) as { cancel: () => void }
}

// The cache button's click: the keep-alive at once (it counts as the person's, so the run starts over).
async function renewNow($: Engine) {
  if (isTurnRunning || isRunning) {
    return
  }
  try {
    await $.prompt.submit({ text: RENEW_TEXT })
  } catch (error) {
    $.ui.toast('Renew ging nicht: ' + String(error).slice(0, 200))
  }
}

async function toggleAutoRenew($: Engine) {
  isAutoRenew = !isAutoRenew
  renewCount = 0
  await $.store.set('auto-renew:' + (await $.session.id()), isAutoRenew)
  await log($, 'auto-renew: ' + isAutoRenew)
  if (!isTurnRunning) {
    startIdle($)
  }
  $.ui.invalidate('ui.render')
}

async function toggleIdleCompact($: Engine) {
  isIdleCompact = !isIdleCompact
  await $.store.set('idle-compact:' + (await $.session.id()), isIdleCompact)
  await log($, 'compact when idle: ' + isIdleCompact)
  if (!isTurnRunning) {
    startIdle($)
  }
  $.ui.invalidate('ui.render')
}

async function pickContextMode($: Engine, mode: ContextMode) {
  isContextMenu = false
  contextMode = mode
  await $.store.set('context-mode', mode)
  $.ui.invalidate('ui.render')
}

async function sayYes($: Engine) {
  try {
    await $.prompt.submit({ text: yesText(), asUser: true })
  } catch (error) {
    $.ui.toast('Senden ging nicht: ' + String(error).slice(0, 200))
  }
}

// The idle or cache figures changed in the settings: running waits start over with them.
function idleChanged($: Engine) {
  if (idleTimer !== undefined || renewTimer !== undefined) {
    startIdle($)
  }
}

// The custom button: a field like the cache's with a symbol in hairlines (as thin as the ice lolly's),
// picked in the settings. An orange dot while it starts something.
const CUSTOM_ICONS = {
  arrows: '<path d="M8 11H21.5M18.5 8L21.5 11L18.5 14"/><path d="M22 17H8.5M11.5 14L8.5 17L11.5 20"/>',
  wind: '<path d="M6 12.4C9.5 10.4 12.5 10.9 15.5 12.1C18.5 13.3 21 12.7 21 10.1C21 8.1 18.4 7.7 18.2 9.5"/>' +
    '<path d="M6 15.4C10 13.5 14 13.9 17.5 15.1C20.5 16.1 24 15.5 24 13.1C24 11.3 21.6 10.9 21.2 12.7"/>' +
    '<path d="M6 18.4C9.5 16.7 13 16.7 16 17.7C18.4 18.5 18.8 21.3 17 21.7C15.4 22 14.8 20.3 15.6 19.5"/>',
  leaf: '<path d="M15 23.5V9"/><path d="M15 9C13.7 7.5 13.7 5.4 15 3.9C16.3 5.4 16.3 7.5 15 9Z"/>' +
    [12.6, 16.2, 19.8].map(y => '<path d="M15 ' + y + 'C12.9 ' + y + ' 11.1 ' + (y - 1.4) + ' 10.8 ' + (y - 3.4) + 'C12.9 ' + (y - 3.4) + ' 14.6 ' + (y - 2) + ' 15 ' + y + 'Z"/>' +
      '<path d="M15 ' + y + 'C17.1 ' + y + ' 18.9 ' + (y - 1.4) + ' 19.2 ' + (y - 3.4) + 'C17.1 ' + (y - 3.4) + ' 15.4 ' + (y - 2) + ' 15 ' + y + 'Z"/>').join(''),
  power: '<path d="M11.44 9.92A6.2 6.2 0 1 0 18.56 9.92"/><path d="M15 6.8V14"/>',
  play: '<path d="M11.4 8.3C11.4 7.3 12.4 6.8 13.2 7.3L21.2 12.7C22 13.2 22 14.8 21.2 15.3L13.2 20.7C12.4 21.2 11.4 20.7 11.4 19.7Z"/>',
} as const
type CustomIcon = keyof typeof CUSTOM_ICONS
const CUSTOM_ICON_NAMES: Record<CustomIcon, string> = { arrows: 'Arrows', wind: 'Wind', leaf: 'Sprig', power: 'Power', play: 'Play' }
const CUSTOM_ICON_LIST = Object.keys(CUSTOM_ICONS) as CustomIcon[]
function customField(icon: CustomIcon, isStarting: boolean) {
  const symbol = '<g fill="none" stroke="' + C_LETTER_GREY + '" stroke-width="0.77" stroke-linecap="round" stroke-linejoin="round">' +
    (CUSTOM_ICONS[icon] ?? CUSTOM_ICONS.play) + '</g>'
  return fieldOf('customfield', 0, symbol, false).replace('</svg>',
    isStarting ? '<circle cx="' + (C_FIELD_W - 4.6) + '" cy="4.6" r="2.7" fill="#f08c00" stroke="#fff" stroke-width="0.8"/></svg>' : '</svg>')
}
const customIcon = (): CustomIcon => (CUSTOM_ICON_LIST.includes(settings.customIcon) ? settings.customIcon : 'play')

// A click on the custom button: when "Opens" is a web address that does not answer and "Starts" is
// set, it starts that first (hidden, not a child of this call) and waits for the address; then it
// opens the address, file or folder. Nothing set: the settings.
let isCustomStarting = false
const CUSTOM_WAIT_MS = 40000
const pause = ($: Engine, ms: number) => new Promise<void>(done => { $.clock.after(ms, () => done()) })
async function answers($: Engine, url: string) {
  try {
    const response = await $.http.fetch(url)
    return response.status > 0
  } catch {
    return false
  }
}
async function startDetached($: Engine, line: string) {
  const bare = line.replace(/^"(.*)"$/, '$1')
  if (platform === 'windows') {
    const quote = (text: string) => "'" + text.replace(/'/g, "''") + "'"
    const isFile = !bare.includes('"') && (await $.fs.exists(bare))
    const script = isFile
      ? 'Start-Process -FilePath ' + quote(bare) + ' -WindowStyle Hidden'
      : 'Start-Process -FilePath cmd.exe -ArgumentList ' + quote('/c ' + line) + ' -WindowStyle Hidden'
    return $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 15000 })
  }
  return $.process.run(['sh', '-c', 'nohup sh -c "$0" >/dev/null 2>&1 &', line], { timeoutMs: 15000 })
}
async function runCustom($: Engine) {
  const target = settings.customOpen.trim()
  const start = settings.customStart.trim()
  if (target === '' && start === '') {
    await openSettings($)
    return
  }
  if (isCustomStarting) {
    return
  }
  await resolvePlatform($)
  const isUrl = /^https?:\/\//i.test(target)
  if (start !== '' && !(isUrl && (await answers($, target)))) {
    isCustomStarting = true
    $.ui.invalidate('ui.render')
    try {
      const ran = await startDetached($, start)
      await log($, 'custom start: exit ' + ran.exitCode + ' ' + ran.stderr.slice(0, 200))
      if (isUrl) {
        const until = (await $.clock.now()) + CUSTOM_WAIT_MS
        while (!(await answers($, target)) && (await $.clock.now()) < until) {
          await pause($, 1000)
        }
      }
    } catch (error) {
      $.ui.toast('Start ging nicht: ' + String(error).slice(0, 200))
    } finally {
      isCustomStarting = false
      $.ui.invalidate('ui.render')
    }
  }
  if (target === '') {
    return
  }
  try {
    if (isUrl) {
      await $.process.run(platform === 'windows' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', target] : platform === 'mac' ? ['open', target] : ['xdg-open', target])
    } else {
      await open($, target)
    }
  } catch (error) {
    $.ui.toast('Could not open: ' + String(error).slice(0, 150))
  }
}

// One of the band's buttons. Each keeps its look (a drawing where it has one); an invisible region
// of hover.tsx over it shows a dim hint while the pointer is on it and runs the action on a click.
// Without regions, plain buttons.
function buttonOf($: Engine, ui: any, id: ButtonId, label: string, drawing?: string, isOnField = false, size = THUMB_SIZE, height = size) {
  const { Box, Button, Svg, Client } = ui
  const isDrawn = drawing !== undefined && Svg !== undefined && Client !== undefined
  const press = () => {
    $.clock.after(0, () => void pressButton($, id))
  }
  return (
    <Box key={'wrap-' + id} position="relative" flexShrink={0}>
      {isDrawn && !isOnField ? (
        <Svg key={'look-' + id} source={drawing} alt={label} width={size} height={height} />
      ) : (
        <Button key={id} label={isDrawn ? ' ' : label} dimColor onPress={press} />
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
    isContextMenu = false
  } else if (id === 'compact') {
    await toggleAutoRenew($)
  } else if (id === 'handover') {
    isContextMenu = !isContextMenu
    isPicking = false
  } else if (id === 'yes' || id === 'custom') {
    // A right click on the thumb or the custom button opens the settings.
    void openSettings($)
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
    await renewNow($)
  } else if (id === 'idle') {
    await toggleIdleCompact($)
  } else if (id === 'custom') {
    await runCustom($)
  } else if (id === 'yes') {
    await sayYes($)
  } else if (contextMode === 'compact') {
    await compact($)
  } else if (contextMode === 'full') {
    await handoff($, lastIsWorking)
  } else {
    await askHandover($)
  }
}

// The dim hint, one line: cut with an ellipsis when the band is short of room.
// With the thumb it takes all the free room, so it starts at the band's left end.
// Without a hint it keeps no room: the hovered file name takes it, and the thumb stays.
function hintOf(Box: any, Text: any, fill = false) {
  return (
    <Box key="hint" marginRight={hint === undefined ? undefined : 'md'} flexGrow={fill ? 1 : 0} flexShrink={1} minWidth={hint === undefined ? 0 : cfg.textRoom}>
      <Text dimColor wrap="truncate-end">{hint === undefined ? '' : hintText(hint)}</Text>
    </Box>
  )
}

// A message from a hover region (hover.tsx) over one of these buttons: the pointer coming and going,
// a left and a right click. False when it is not about these buttons.
function handoffMessage($: Engine, data: { action?: string; id?: string } | undefined) {
  const id = data?.id as ButtonId | undefined
  if (id === undefined || !BUTTONS.includes(id)) {
    return false
  }
  if (data?.action === 'press') {
    $.clock.after(0, () => void pressButton($, id))
  } else if (data?.action === 'menu') {
    $.clock.after(0, () => void rightClick($, id))
  } else if (data?.action === 'enter' || data?.action === 'leave') {
    const nextHint = data.action === 'enter' ? id : hint === id ? undefined : hint
    if (nextHint !== hint) {
      hint = nextHint
      $.ui.invalidate('ui.render')
    }
  }
  return true
}

// The band: the thumb and the hint at the left end, then middle (the path buttons), then ⌾, the cache
// and the context button, each as the settings show it.
async function handoffBand($: Engine, e: any, ui: any, middle: any) {
  const { Box, Button, Text } = ui
  const id = await $.session.id()
  if (backFor !== id) {
    backFor = id
    backTo = (await $.store.get('back:' + id)) as typeof backTo
  }
  const back = cfg.handover ? backTo : undefined
  await loadState($)
  if (!cfg.advisor) {
    isPicking = false
  }
  if (!cfg.handover) {
    isContextMenu = false
  }
  const isMenu = isPicking || isContextMenu
  const minutesLeft = e.props.isWorking || !cfg.compact ? 0 : await cacheLeft($, id)
  minutesShown = minutesLeft
  // Expired: a reply was cached once, its time is up, and nothing runs now.
  const isExpired = cfg.compact && !e.props.isWorking && minutesLeft === 0 && (cacheFrom.get(id) ?? 0) > 0
  isExpiredShown = isExpired
  if (cfg.handover && !contextOf.has(id)) {
    contextOf.set(id, 0)
    $.clock.after(0, () => void readContext($, id))
  }
  if (minutesLeft > 0) {
    $.clock.after(0, () => tick($))
  }
  lastIsWorking = e.props.isWorking
  lastBack = back
  const button = (id: ButtonId, label: string, drawing?: string) => buttonOf($, ui, id, label, drawing)
  const isThumbHere = thumbFits(e.props.bodyColumns ?? 200)

  return (
    <Box justifyContent="flex-end" alignItems="center" gap="sm">
      {isThumbHere && button('yes', '👍', THUMB)}
      {!isContextMenu && (isThumbHere || hint !== undefined) && hintOf(Box, Text, isThumbHere)}
      {!isMenu && middle}
      {!isMenu && back !== undefined && button('back', '<<')}
      {/* After a right click on ⌾ the models stand left of it, the other buttons out of the way;
          the chosen model at full strength. */}
      {isPicking && MODELS.map(model => (
        <Button key={'model-' + model} label={MODEL_NAMES[model]} plain dimColor={model !== advisorModel} onPress={() => {
          $.clock.after(0, () => void pickModel($, model))
        }} />
      ))}
      {cfg.advisor && !isContextMenu && button('advisor', '⌾')}
      {!isMenu && settings.custom && buttonOf($, ui, 'custom', settings.customName.trim() || 'Custom',
        customField(customIcon(), isCustomStarting), false, C_FIELD_W, C_FIELD_H)}
      {!isMenu && cfg.compact && buttonOf($, ui, 'compact', 'Cache', cacheField(minutesLeft, isAutoRenew, isExpired), false, C_FIELD_W, C_FIELD_H)}
      {/* After a right click on the context button: its modes, the chosen one at full strength, and the
          compact-when-idle switch. */}
      {isContextMenu && CONTEXT_MODES.map(mode => (
        <Button key={'cmode-' + mode} label={CONTEXT_MODE_NAMES[mode]} plain dimColor={mode !== contextMode} onPress={() => {
          $.clock.after(0, () => void pickContextMode($, mode))
        }} />
      ))}
      {isContextMenu && (
        <Box key="idle-switch" flexDirection="row" alignItems="center" gap="xs" marginLeft="md" flexShrink={0}>
          {buttonOf($, ui, 'idle', 'Idle', switchDrawing(isIdleCompact, C_DOT_RED), false, 30, 16)}
          <Text dimColor={!isIdleCompact} wrap="truncate-end">Idle compact</Text>
        </Box>
      )}
      {!isPicking && cfg.handover && buttonOf($, ui, 'handover', CONTEXT_LETTERS[contextMode], contextField(contextOf.get(id) ?? 0, isIdleCompact, contextMode), false, C_FIELD_W, C_FIELD_H)}
    </Box>
  )
}

// /import-chat, registered from register.tsx's session.start (one hook per event).
async function registerCommands($: Engine) {
  await $.command.register({
    name: 'import-chat',
    description: 'Einen exportierten Chat aus "Claude Handoffs" in diesen Chat laden',
    argumentHint: '[Nummer oder Name]',
  })
}

// The handoff hooks besides the band and the messages, which register.tsx routes here.
function registerHandoff(on: Parameters<Register>[0]) {
  // Compact when idle: the timer runs from the end of the main chat's reply to the next one.
  on('turn.start', async ($, e, next) => {
    if ((e as any).agentId === undefined) {
      isTurnRunning = true
      stopIdle()
      // A reply to the keep-alive keeps counting; anything else starts the count over.
      if (isRenewSent) {
        isRenewSent = false
      } else {
        renewCount = 0
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if ((e as any).agentId === undefined) {
      isTurnRunning = false
      await loadState($)
      const chat = await $.session.id()
      const now = await $.clock.now()
      cacheFrom.set(chat, now)
      await $.store.set('cache-from:' + chat, now)
      void readContext($, chat)
      startIdle($)
      tick($)
    }
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
}

// ---- The path buttons ----

// One round, single-colour emoji per path: the same dot sits in front of the path
// in the text and on its button, so the colour is the link between the two.
const DOTS = ['🔴', '🟠', '🟢', '🔵', '🟡', '🟣', '⚪']
const MAX_BUTTONS = DOTS.length

// Absolute paths on any system: a drive letter (C:\...), a POSIX path (/Users/..., /home/...)
// or one under the home folder (~/...). Backticked paths may hold spaces; bare ones end at
// whitespace or quoting. A bare POSIX path counts only under a usual top folder, so `and/or`
// or a URL's path does not turn into a button.
const PATH =
  /`([A-Za-z]:[\\/][^`\n]+|~?\/[^`\s\n/][^`\n]*\/[^`\n]+)`|(?<![A-Za-z0-9])([A-Za-z]:[\\/][^\s`"'<>|*?()[\]]+)|(?<![\w:/.~-])(~?\/(?:Users|home|Volumes|mnt|media|opt|srv|tmp|var|private|Applications|Library)\/[^\s`"'<>|*?()[\]]+)/g

// Short relative paths (`blender\shot\...`) resolve against the session's project folder (base).
// A relative path only counts when its first folder is a folder at the top of the project (read
// from disk, nothing to set up), so ordinary words with a slash do not turn into buttons.
let base = ''
let home = ''
let topFolders: string[] = []
let topFoldersOf = ''
let topFoldersAt = 0
// Matches nothing until a project folder is known.
let REL = /(?!)()()/g

// The pattern for relative paths: one of the project's top folders as first part.
function buildRelative() {
  const roots = topFolders
  if (roots.length === 0) {
    REL = /(?!)()()/g
    return
  }
  const first = roots.map(root => root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  REL = new RegExp(
    '`((?:' + first + ')[\\\\/][^`\\n]+)`|(?<![A-Za-z0-9:\\\\/._-])((?:' + first + ')[\\\\/][^\\s`"\'<>|*?()[\\]]+)',
    'gi',
  )
}

// Path -> colour index, handed out in order of first sight and kept for the session,
// so a path keeps its colour wherever it shows up again.
const colours = new Map<string, number>()
let nextColour = 0

const clean = (raw: string) =>
  raw
    .trim()
    .replace(/[.,;:!]+$/, '')
    .replace(/:\d+(:\d+)?$/, '')

// The parts of a path, whichever separator it uses, and the separator a path is written with.
const partsOf = (path: string) => path.split(/[\\/]/).filter(part => part !== '')
const sepOf = (path: string) => (/^[A-Za-z]:/.test(path) || path.includes('\\') ? '\\' : '/')
const nameOf = (path: string) => partsOf(path).pop() ?? path

// The shape tells the kind, the colour links text and button: hearts for videos, squares for
// images, dots for everything else. All lists share the colour order.
const HEARTS = ['❤️', '🧡', '💚', '💙', '💛', '💜', '🤍']
const SQUARES = ['🟥', '🟧', '🟩', '🟦', '🟨', '🟪', '⬜']
const VIDEO = /\.(mp4|mov|mkv|avi|webm|m4v|mxf)$/i
const IMAGE = /\.(png|jpe?g|webp|bmp|gif|tiff?|exr|hdr|tga|dpx)$/i
const TEXT = /\.(md|txt)$/i

function dotFor(path: string) {
  const key = path.toLowerCase()
  let index = colours.get(key)
  if (index === undefined) {
    index = nextColour++ % DOTS.length
    colours.set(key, index)
  }
  const set = VIDEO.test(path) ? HEARTS : IMAGE.test(path) ? SQUARES : DOTS
  return set[index]
}

const markFor = dotFor

// A cleaned path as an absolute one: relative paths get the project folder in front.
function absolute(raw: string) {
  const path = clean(raw)
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return path.replace(/\//g, '\\')
  }
  if (path.startsWith('~/')) {
    return home === '' ? '' : home + path.slice(1).replace(/\//g, sepOf(home))
  }
  if (path.startsWith('/')) {
    return path
  }
  if (base === '') {
    return ''
  }
  const sep = sepOf(base)
  return base + sep + partsOf(path).join(sep)
}

// The project folder of the session, so relative paths open in the project the chat runs in.
async function syncBase($: Engine) {
  await resolvePlatform($)
  try {
    const root = (await $.session.root()).replace(/[\\/]+$/, '')
    if (/^[A-Za-z]:[\\/]/.test(root)) {
      base = root.replace(/\//g, '\\')
    } else if (root.startsWith('/')) {
      base = root
    }
  } catch {
    // keep the last known folder
  }
  // The folders at the top of the project, read again when the project changes or after half a minute.
  if (base !== '' && (base !== topFoldersOf || Date.now() - topFoldersAt > 30000)) {
    topFoldersOf = base
    topFoldersAt = Date.now()
    try {
      const entries = await $.fs.list(base)
      topFolders = entries.filter(entry => entry.kind === 'dir').map(entry => entry.name)
    } catch {
      topFolders = []
    }
    buildRelative()
  }
}

// The distinct paths of a text (absolute and relative), in order of appearance, as absolute paths.
function pathsOf(text: string) {
  const hits = [...text.matchAll(PATH), ...text.matchAll(REL)]
    .map(match => ({ at: match.index ?? 0, raw: match[1] ?? match[2] ?? match[3] ?? '' }))
    .sort((a, b) => a.at - b.at)
  const found: string[] = []
  for (const { raw } of hits) {
    const path = absolute(raw)
    if (path.length > 3 && !found.some(known => known.toLowerCase() === path.toLowerCase())) {
      found.push(path)
    }
  }
  return found
}

// Which system the session runs on, read once from the environment: the open command,
// the temp folder and where ffmpeg may sit depend on it.
let platform: 'windows' | 'mac' | 'linux' | '' = ''
let TEMP = ''

async function resolvePlatform($: Engine) {
  if (platform !== '') {
    return
  }
  const windir = await $.env.get('windir')
  if (windir !== undefined || (await $.env.get('OS')) === 'Windows_NT') {
    platform = 'windows'
  } else if (await $.fs.exists('/System/Library/CoreServices')) {
    platform = 'mac'
  } else {
    platform = 'linux'
  }
  home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/[\\/]+$/, '')
  TEMP = ((await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? (platform === 'windows' ? 'C:\\Windows\\Temp' : '/tmp')).replace(/[\\/]+$/, '')
}

const tempFile = (name: string) => TEMP + sepOf(TEMP) + name

// The person's choices from the settings pane, kept across sessions in the plugin's store.
// An empty program means the system's own app. textRoom: the columns kept for the hovered name and
// the buttons' hint. The rest is for the thumb, ⌾, C and H (handoff.tsx): which show, the idle and
// cache figures, the thumb's language and the advisor model a new chat starts with.
type Settings = {
  folderApp: string
  mediaApp: string
  threeDApp: string
  previews: boolean
  symbols: boolean
  textRoom: number
  thumb: boolean
  advisor: boolean
  compact: boolean
  handover: boolean
  idleMinutes: number
  idlePercent: number
  cacheMinutes: number
  renewLead: number
  renewMax: number
  language: Language
  advisorModel: Model
  // The thumb's own text per language; before 0.14 one text for all (thumbText).
  thumbTexts: Partial<Record<Language, string>>
  thumbText?: string
  // The custom button: its name (the hint), its symbol, what it opens (a web address, file or folder)
  // and what it starts when the address does not answer.
  custom: boolean
  customName: string
  customIcon: CustomIcon
  customOpen: string
  customStart: string
}
const DEFAULTS: Settings = {
  folderApp: '', mediaApp: '', threeDApp: '', previews: true, symbols: true, textRoom: 10,
  thumb: true, advisor: false, compact: true, handover: true,
  idleMinutes: 55, idlePercent: 50, cacheMinutes: 60, renewLead: 1, renewMax: 2, language: 'en', advisorModel: 'opus', thumbTexts: {},
  custom: false, customName: '', customIcon: 'play', customOpen: '', customStart: '',
}
let settings: Settings = { ...DEFAULTS }
let isSettingsLoaded = false

// Hands the settings to the buttons of handoff.tsx.
function applySettings() {
  cfg.thumb = settings.thumb
  cfg.advisor = settings.advisor
  cfg.compact = settings.compact
  cfg.handover = settings.handover
  cfg.idleMinutes = settings.idleMinutes
  cfg.idlePercent = settings.idlePercent
  cfg.cacheMinutes = settings.cacheMinutes
  cfg.renewLead = settings.renewLead
  cfg.renewMax = settings.renewMax
  cfg.language = LANGUAGES.includes(settings.language) ? settings.language : 'en'
  cfg.advisorModel = MODELS.includes(settings.advisorModel) ? settings.advisorModel : 'opus'
  cfg.textRoom = settings.textRoom
  cfg.thumbText = settings.thumbTexts?.[cfg.language] ?? ''
}

async function loadSettings($: Engine) {
  if (isSettingsLoaded) {
    return
  }
  isSettingsLoaded = true
  try {
    const stored = (await $.store.get('settings')) as Partial<Settings> | undefined
    settings = { ...DEFAULTS, ...(stored ?? {}) }
    if (typeof settings.thumbText === 'string' && settings.thumbText !== '' && Object.keys(settings.thumbTexts ?? {}).length === 0) {
      settings.thumbTexts = { [settings.language]: settings.thumbText }
    }
    delete settings.thumbText
  } catch {
    settings = { ...DEFAULTS }
  }
  applySettings()
}

async function saveSettings($: Engine, change: Partial<Settings>) {
  settings = { ...settings, ...change }
  applySettings()
  await $.store.set('settings', settings)
  if (change.idleMinutes !== undefined || change.cacheMinutes !== undefined || change.renewMax !== undefined || change.renewLead !== undefined) {
    idleChanged($)
  }
  $.ui.invalidate('ui.render')
}

// A whole number typed in the pane, kept when it lies in [least, most].
async function saveNumber($: Engine, field: 'textRoom' | 'idleMinutes' | 'idlePercent' | 'cacheMinutes' | 'renewLead' | 'renewMax', text: string) {
  const ranges = { textRoom: [8, 80], idleMinutes: [1, 600], idlePercent: [1, 100], cacheMinutes: [1, 600], renewLead: [1, 30], renewMax: [1, 48] } as const
  const [least, most] = ranges[field]
  const value = Math.round(Number(text.trim()))
  if (!Number.isFinite(value) || value < least || value > most) {
    $.ui.toast(least + ' to ' + most + ', please.')
    return
  }
  await saveSettings($, { [field]: value })
}

// Where installed, Directory Opus, the Chaos Player and F3D are only named in the settings pane, as
// paths to copy: every kind opens in the system's default app until a program is set.
const OPUS_SUBPATH = '\\GPSoftware\\Directory Opus\\dopusrt.exe'
const CHAOS_SUBPATH = '\\Chaos\\Player\\chaosplayer_qt5.exe'
const F3D_SUBPATH = '\\F3D\\bin\\f3d.exe'
let OPUS = ''
let CHAOS_PLAYER = ''
let F3D = ''
let isResolved = false

// Looked up once per load in the Program Files folders of this machine: no install path is baked in.
async function resolvePrograms($: Engine) {
  if (isResolved) {
    return
  }
  isResolved = true
  if (platform !== 'windows') {
    return
  }
  const candidates = [
    await $.env.get('ProgramFiles'),
    await $.env.get('ProgramW6432'),
    await $.env.get('ProgramFiles(x86)'),
  ]
  const roots = candidates.filter((root, i): root is string => root !== undefined && candidates.indexOf(root) === i)
  for (const root of roots) {
    if (F3D === '' && (await $.fs.exists(root + F3D_SUBPATH))) {
      F3D = root + F3D_SUBPATH
    }
    if (OPUS === '' && (await $.fs.exists(root + OPUS_SUBPATH))) {
      OPUS = root + OPUS_SUBPATH
    }
    if (CHAOS_PLAYER === '' && (await $.fs.exists(root + CHAOS_SUBPATH))) {
      CHAOS_PLAYER = root + CHAOS_SUBPATH
    }
  }
}

// Brings the Opus lister that shows a folder to the front. Written to the temp folder
// on use, so the mod needs no file of its own beside the module.
const FOCUS_OPUS = `# Brings the Directory Opus lister that shows the given folder to the front.
param([string]$Folder)
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class OpusWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, int f, int e);
  public static List<KeyValuePair<IntPtr,string>> Listers() {
    var r = new List<KeyValuePair<IntPtr,string>>();
    EnumWindows((h, l) => {
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() == "dopus.lister" && IsWindowVisible(h)) {
        var t = new StringBuilder(512); GetWindowText(h, t, 512);
        r.Add(new KeyValuePair<IntPtr,string>(h, t.ToString()));
      }
      return true;
    }, IntPtr.Zero);
    return r;
  }
  public static void Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, 0);          // a tap on Alt lets the call take the foreground
    SetForegroundWindow(h);
    keybd_event(0x12, 0, 2, 0);
  }
}
"@
$leaf = Split-Path $Folder -Leaf
$target = $null
for ($i = 0; $i -lt 12 -and $null -eq $target; $i++) {
  $listers = [OpusWin]::Listers()
  foreach ($l in $listers) { if ($l.Value -like "*$leaf*") { $target = $l.Key; break } }
  if ($null -eq $target) { Start-Sleep -Milliseconds 150 }
}
if ($null -eq $target -and $listers.Count -gt 0) { $target = $listers[0].Key }
if ($null -ne $target) { [OpusWin]::Front($target); "front" } else { "no lister" }
`

const MEDIA = /\.(png|jpe?g|webp|bmp|gif|tiff?|exr|hdr|tga|dpx|mp4|mov|mkv|avi|webm|m4v|mxf)$/i
// 3D files: meshes and exchange formats a viewer shows. Scene files (.blend, .hip) open in their own program (the system's default app: Blender, Houdini).
const MODEL3D = /\.(glb|gltf|fbx|obj|usd|usda|usdc|usdz|abc|stl|ply|3mf|dae)$/i

// Text files (TEXT, above) show in a pane of this chat instead of an outside app.
const VIEWER = 'bright-buttons-viewer'
const SETTINGS = 'bright-buttons-settings'
const VIEW_MAX_CHARS = 200000
let viewing: { path: string; text: string; isMarkdown: boolean } | undefined

async function view($: Engine, path: string) {
  const whole = String(await $.fs.read(path))
  const isCut = whole.length > VIEW_MAX_CHARS
  viewing = {
    path,
    text: isCut ? whole.slice(0, VIEW_MAX_CHARS) + '\n\n[... cut]' : whole,
    isMarkdown: /\.md$/i.test(path),
  }
  await $.ui.open({ id: VIEWER, title: nameOf(path) })
  $.ui.invalidate('ui.render')
}

// Starts a chosen program on a path without waiting for it: a long-running app must not be a
// child of this call, which ends it after 30 s.
function launch(program: string, path: string) {
  if (platform === 'windows') {
    return ['cmd.exe', '/c', 'start', '', program, path]
  }
  if (platform === 'mac' && /\.app\/?$/i.test(program)) {
    return ['open', '-a', program, path]
  }
  return ['sh', '-c', 'nohup "$0" "$1" >/dev/null 2>&1 &', program, path]
}

// The system's own way to open a path in its default app.
function openDefault(path: string) {
  return platform === 'windows' ? ['explorer.exe', path] : platform === 'mac' ? ['open', path] : ['xdg-open', path]
}

// A program set by its bare name (f3d.exe): the full path of one found on this computer by that
// name, else where Windows finds it on the PATH, else the name as it is.
async function programOf($: Engine, program: string) {
  if (program === '' || /[\\/]/.test(program)) {
    return program
  }
  const wanted = program.toLowerCase().replace(/\.exe$/, '')
  const known = [OPUS, CHAOS_PLAYER, F3D].find(full => full !== '' && nameOf(full).toLowerCase().replace(/\.exe$/, '') === wanted)
  if (known !== undefined) {
    return known
  }
  if (platform === 'windows') {
    try {
      const ran = await $.process.run(['where.exe', program], { timeoutMs: 5000 })
      const first = ran.stdout.split(/\r?\n/)[0]?.trim() ?? ''
      if (ran.exitCode === 0 && first !== '') {
        return first
      }
    } catch {
      // not found: the name as it is
    }
  }
  return program
}

async function open($: Engine, path: string) {
  await resolvePlatform($)
  await loadSettings($)
  let kind: 'file' | 'dir' | 'other' | undefined
  try {
    kind = (await $.fs.stat(path)).kind
  } catch {
    kind = undefined
  }
  if (kind === undefined) {
    $.ui.toast('Path does not exist: ' + path)
    return
  }
  const isFolder = kind === 'dir'
  if (!isFolder && TEXT.test(path)) {
    try {
      await view($, path)
    } catch (error) {
      $.ui.toast('Could not show: ' + String(error).slice(0, 150))
    }
    return
  }
  await resolvePrograms($)
  const folderApp = await programOf($, settings.folderApp)
  const mediaApp = await programOf($, settings.mediaApp)
  const threeDApp = await programOf($, settings.threeDApp)
  let command = openDefault(path)
  // Directory Opus set for folders (its dopusrt.exe): jump to the folder in a tab, an existing one if open.
  const isOpus = isFolder && /dopusrt\.exe$/i.test(folderApp)
  if (isOpus) {
    command = [folderApp, '/cmd', 'Go', path, 'NEWTAB=findexisting']
  } else if (isFolder && folderApp !== '') {
    command = launch(folderApp, path)
  } else if (!isFolder && MEDIA.test(path) && mediaApp !== '') {
    command = launch(mediaApp, path)
  } else if (!isFolder && MODEL3D.test(path) && threeDApp !== '') {
    command = launch(threeDApp, path)
  }
  try {
    const ran = await $.process.run(command)
    // The exit code of a default app or of a launcher that hands over means nothing,
    // but Opus reporting an error is worth seeing.
    if (isOpus && ran.exitCode !== 0) {
      $.ui.toast('Directory Opus: exit ' + ran.exitCode + ' ' + ran.stderr.slice(0, 120))
    }
    if (isOpus) {
      // Go switches the tab but leaves the window where it was: bring it forward.
      const script = tempFile('bright-buttons-focus-opus.ps1')
      await $.fs.write(script, FOCUS_OPUS)
      await $.process.run(
        ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Folder', path],
        { timeoutMs: 8000 },
      )
    }
  } catch (error) {
    $.ui.toast('Could not open: ' + String(error).slice(0, 150))
  }
}

// Preview of the newest image among the buttons, drawn as a small Svg in the band.
// ffmpeg makes a small PNG in the temp folder; render only reads the cache, the work runs after it.
const THUMB_HEIGHT = 72
const THUMB_DRAWN = 30
const thumbs = new Map<string, { jpg: string; width: number; height: number }>()
const thumbsPending = new Set<string>()
const thumbsFailed = new Set<string>()
// Letterbox colours in the order of the symbol lists (red, orange, green, blue, yellow, purple, white as grey).
const FRAMES = ['#e0303a', '#f5821f', '#3cb44b', '#3a78d8', '#f2c40f', '#8e44ad', '#b0b0b0']

// Flat symbols for the band in the path's colour, on a 24 x 24 grid; holes are cut, so any background shows through.
const ICON_DRAWN = 22
// The room kept at the band's left for the hovered file name (columns), so it never gets squeezed
// out: settings.textRoom.
// Columns kept for ⌾, C and H right of the paths: about 8 each, the gaps besides.
const othersRoom = () => 6 + 8 * [settings.advisor, settings.custom, settings.compact, settings.handover].filter(Boolean).length
// The columns the thumb takes at the band's left end, with its gap.
const THUMB_ROOM = 6
// Where the estimates fall short, the name gives way, down to this many columns.
const NAME_LEAST = 8
// About how many pixels a column of the band is wide in the desktop app.
const COLUMN_PIXELS = 9
// About how many columns a path takes in the band: a preview its width, a symbol or dot about three.
function columnsOf(path: string) {
  const thumb = settings.previews && MEDIA.test(path) ? thumbs.get(path.toLowerCase()) : undefined
  if (thumb === undefined) {
    return 3
  }
  const width = (THUMB_DRAWN * thumb.width) / Math.max(1, thumb.height)
  return Math.ceil((width + 6) / COLUMN_PIXELS)
}
// A grey open hand, shown while the band shows older paths.
const HAND =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<path fill="none" stroke="#9a9a9a" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" ' +
  'd="M7.6 21.4 C6.2 20.2 5.2 18.4 4.6 16.6 L2.7 12.9 A1.25 1.25 0 0 1 4.9 11.7 L6.7 14.3 V6.2 A1.2 1.2 0 0 1 9.1 6.2 V11.2 V4.4 A1.2 1.2 0 0 1 11.5 4.4 V11.2 V5.2 A1.2 1.2 0 0 1 13.9 5.2 V11.6 V7.6 A1.2 1.2 0 0 1 16.3 7.6 V14.8 C16.3 18.6 14.6 21.4 11.6 21.4 Z"/></svg>'
// A disc in the colour with a sign cut out of it, so the background shows through the sign.
const disc = (colour: string, cut: string) =>
  `<mask id="cut"><rect width="24" height="24" fill="#fff"/><g fill="#000" stroke="#000">${cut}</g></mask>` +
  `<circle cx="12" cy="12.5" r="9.2" fill="${colour}" mask="url(#cut)"/>`
const ICONS: { test: (path: string) => boolean; draw: (colour: string) => string }[] = [
  {
    // A Blender file: the tilted ring with its eye and three arms, after the Blender logo.
    test: path => /\.blend\d*$/i.test(path),
    draw: c =>
      `<g fill="${c}" stroke="${c}" stroke-width="2.1" stroke-linecap="round">` +
      `<path stroke="none" fill-rule="evenodd" d="M6.8 14a7.7 7.2 0 1 0 15.4 0a7.7 7.2 0 1 0 -15.4 0z M9.6 13.1a4.6 3.9 0 1 0 9.2 0a4.6 3.9 0 1 0 -9.2 0z"/>` +
      `<ellipse stroke="none" cx="14.3" cy="13.1" rx="2.8" ry="2.4"/>` +
      `<path fill="none" d="M14 4.2 L18.2 9.2 M7.6 8.3 L16 8.3 M4.3 14.9 L9.6 10.2"/></g>`,
  },
  {
    // A Houdini scene or asset: a disc with a spiral cut out of it.
    test: path => /\.(hip|hiplc|hipnc|hda|hdalc|hdanc|otl)$/i.test(path),
    draw: c =>
      `<mask id="spiral"><circle cx="12" cy="12.5" r="9" fill="#fff"/>` +
      `<path d="M8.6 14.3 L8.6 14.0 L8.7 13.6 L9.0 13.3 L9.3 13.1 L9.7 12.9 L10.2 12.8 L10.7 12.9 L11.2 13.2 L11.6 13.6 L12.0 14.1 L12.2 14.7 L12.2 15.4 L12.0 16.1 L11.6 16.8 L11.0 17.4 L10.3 17.8 L9.4 18.0 L8.5 18.0 L7.6 17.7 L6.8 17.2 L6.1 16.4 L5.6 15.5 L5.3 14.4 L5.4 13.2 L5.8 12.1 L6.5 11.1 L7.4 10.3 L8.6 9.7 L9.9 9.5 L11.2 9.6 L12.5 10.1 L13.7 10.9 L14.7 12.0 L15.3 13.4 L15.6 14.9 L15.4 16.5 L14.8 18.0 L13.9 19.3 L12.6 20.4 L11.0 21.1 L9.2 21.4 L7.5 21.2 L5.7 20.5 L4.2 19.4 L3.0 17.9 L2.2 16.2 L2.0 14.2 L2.2 12.2" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round"/></mask>` +
      `<circle cx="12" cy="12.5" r="9" fill="${c}" mask="url(#spiral)"/>`,
  },
  {
    // A Python or other script: a single prompt sign.
    test: path => /\.(pyw?|ps1|psm1|sh|bat|cmd|js|mjs|cjs|ts|tsx|jsx)$/i.test(path),
    draw: c =>
      `<path d="M8.5 7 L15.5 13 L8.5 19" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    // A log file: a slice of a tree trunk, rings, heart and a crack.
    test: path => /\.log$/i.test(path),
    draw: c =>
      `<g fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round">` +
      `<circle cx="12" cy="13" r="8.2"/><circle cx="12" cy="13" r="4.6"/><path stroke-width="1.5" d="M18.2 7.6 L15.4 10.2"/></g>` +
      `<circle cx="12" cy="13" r="1.5" fill="${c}"/>`,
  },
  {
    // A video, until its preview is ready or where none can be made: a film reel.
    test: path => VIDEO.test(path),
    draw: c =>
      `<path transform="translate(1 0.5)" fill="${c}" fill-rule="evenodd" d="M2.50 12.00a8.5 8.5 0 1 0 17.0 0a8.5 8.5 0 1 0 -17.0 0zM8.90 7.30a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0zM13.37 10.55a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0zM11.66 15.80a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0zM6.14 15.80a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0zM4.43 10.55a2.1 2.1 0 1 0 4.2 0a2.1 2.1 0 1 0 -4.2 0zM10.10 12.00a0.9 0.9 0 1 0 1.8 0a0.9 0.9 0 1 0 -1.8 0z"/>`,
  },
  {
    // Data and settings (JSON, YAML, XML, INI, OCIO ...): a gear with eight short teeth and a hole.
    test: path => /\.(json|jsonl|json5|ya?ml|xml|toml|ini|cfg|conf|ocio|env)$/i.test(path),
    draw: c =>
      `<mask id="hub"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="12.5" r="2.3" fill="#000"/></mask>` +
      `<g fill="${c}" mask="url(#hub)"><circle cx="12" cy="12.5" r="6.3"/>` +
      `<rect x="10.55" y="5.0" width="2.9" height="2.2" rx="0.6" transform="rotate(0 12 12.5)"/><rect x="10.55" y="5.0" width="2.9" height="2.2" rx="0.6" transform="rotate(45 12 12.5)"/><rect x="10.55" y="5.0" width="2.9" height="2.2" rx="0.6" transform="rotate(90 12 12.5)"/><rect x="10.55" y="5.0" width="2.9" height="2.2" rx="0.6" transform="rotate(135 12 12.5)"/><rect x="10.55" y="5.0" width="2.9" height="2.2" rx="0.6" transform="rotate(180 12 12.5)"/><rect x="10.55" y="5.0" width="2.9" height="2.2" rx="0.6" transform="rotate(225 12 12.5)"/><rect x="10.55" y="5.0" width="2.9" height="2.2" rx="0.6" transform="rotate(270 12 12.5)"/><rect x="10.55" y="5.0" width="2.9" height="2.2" rx="0.6" transform="rotate(315 12 12.5)"/></g>`,
  },
  {
    // A 3D exchange file (USD, glTF, FBX, OBJ, Alembic ...): a wire cube, its visible edges.
    test: path => /\.(usd|usda|usdc|usdz|glb|gltf|fbx|obj|abc|ply|stl)$/i.test(path),
    draw: c =>
      `<path fill="none" stroke="${c}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ` +
      `d="M12.00 3.90 L19.45 8.20 L19.45 16.80 L12.00 21.10 L4.55 16.80 L4.55 8.20Z` +
      `M12.00 12.50L4.55 8.20M12.00 12.50L19.45 8.20M12.00 12.50L12.00 21.10"/>`,
  },
  {
    // A PDF: a filled page, its corner folded down.
    test: path => /\.pdf$/i.test(path),
    draw: c =>
      `<g fill="${c}"><path d="M6.5 2.5H12.8V7.6a1.6 1.6 0 0 0 1.6 1.6H19.5V20a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2z"/>` +
      `<path stroke="${c}" stroke-width="0.8" stroke-linejoin="round" d="M14.3 2.9 L19.1 7.7 H14.3 Z"/></g>`,
  },
  {
    // Model weights (safetensors, checkpoints, GGUF): three linked nodes of a network cut out of a disc.
    test: path => /\.(safetensors|ckpt|pt|pth|gguf|onnx)$/i.test(path),
    draw: c =>
      disc(c, `<path fill="none" stroke-width="1.3" d="M12 8.2L8.2 15L15.8 15Z"/>` +
        `<g stroke="none"><circle cx="12" cy="8.2" r="1.9"/><circle cx="8.2" cy="15" r="1.9"/><circle cx="15.8" cy="15" r="1.9"/></g>`),
  },
  {
    // Markdown and text: just two lines of text, a long one over a short one.
    test: path => TEXT.test(path),
    draw: c =>
      `<g fill="${c}"><rect x="3" y="9.5" width="16" height="2.5" rx="1.25"/><rect x="3" y="15.5" width="12" height="2.5" rx="1.25"/></g>`,
  },
  {
    // A folder: no extension on the last part.
    test: path => !/\.[A-Za-z0-9]{1,5}$/.test(nameOf(path)),
    draw: c =>
      // Drawn at four fifths and a little low, so it stands no bigger than a dot and sits on the line.
      `<path transform="translate(2.4 3.9) scale(0.8)" fill="${c}" d="M2 6.5A1.5 1.5 0 0 1 3.5 5h5l2 2h10A1.5 1.5 0 0 1 22 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18.5z"/>`,
  },
]
let FFMPEG = ''
let isFfmpegResolved = false

async function resolveFfmpeg($: Engine) {
  if (isFfmpegResolved) {
    return
  }
  isFfmpegResolved = true
  await resolvePlatform($)
  const candidates =
    platform === 'windows'
      ? [await $.env.get('ProgramFiles'), await $.env.get('ProgramW6432')].map(root =>
          root === undefined ? undefined : root + '\\ffmpeg\\bin\\ffmpeg.exe',
        )
      : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
  for (const candidate of candidates) {
    if (candidate !== undefined && FFMPEG === '' && (await $.fs.exists(candidate))) {
      FFMPEG = candidate
    }
  }
  if (FFMPEG === '') {
    FFMPEG = 'ffmpeg'
  }
}

async function makeThumb($: Engine, path: string) {
  const key = path.toLowerCase()
  try {
    await resolveFfmpeg($)
    let hash = 0
    for (const char of key) {
      hash = (hash * 31 + char.charCodeAt(0)) | 0
    }
    // A small JPEG: the band's whole drawing has a size limit, and seven PNG previews outgrow it.
    const out = tempFile('bright-buttons-thumb-' + (hash >>> 0).toString(16) + '.jpg')
    const started = Date.now() - 2000
    const frame = ['-frames:v', '1', '-vf', 'scale=-2:' + THUMB_HEIGHT + ',hue=s=0,lutyuv=y=115+val*0.45', '-q:v', '6', out]
    // A video shows its frame at one second (a poster); a clip shorter than that its first frame.
    if (VIDEO.test(path)) {
      await $.process.run([FFMPEG, '-y', '-loglevel', 'error', '-ss', '1', '-i', path, ...frame], { timeoutMs: 15000 })
    }
    if (!VIDEO.test(path) || !(await $.fs.exists(out)) || (await $.fs.stat(out)).mtimeMs < started) {
      const ran = await $.process.run([FFMPEG, '-y', '-loglevel', 'error', '-i', path, ...frame], { timeoutMs: 15000 })
      if (ran.exitCode !== 0) {
        thumbsFailed.add(key)
        return
      }
    }
    const { base64 } = await $.fs.read(out, { as: 'bytes' })
    // JPEG size: the frame header (marker FFC0 to FFC2) holds height and width as 16-bit numbers.
    const bytes = atob(base64)
    let width = 0
    let height = 0
    for (let at = 2; at + 9 < bytes.length; ) {
      if (bytes.charCodeAt(at) !== 0xff) {
        break
      }
      const marker = bytes.charCodeAt(at + 1)
      if (marker >= 0xc0 && marker <= 0xc2) {
        height = (bytes.charCodeAt(at + 5) << 8) | bytes.charCodeAt(at + 6)
        width = (bytes.charCodeAt(at + 7) << 8) | bytes.charCodeAt(at + 8)
        break
      }
      at += 2 + ((bytes.charCodeAt(at + 2) << 8) | bytes.charCodeAt(at + 3))
    }
    if (width === 0 || height === 0) {
      thumbsFailed.add(key)
      return
    }
    thumbs.set(key, { jpg: base64, width, height })
    $.ui.invalidate('ui.render')
  } catch {
    // no preview, no error; a failed image is not tried again in this session
    thumbsFailed.add(key)
  } finally {
    thumbsPending.delete(key)
  }
}

// One worker makes the previews in turn: of several waits started in one render only one ran,
// which left the other previews waiting for good.
const thumbQueue: string[] = []
let isMakingThumbs = false

async function makeThumbs($: Engine) {
  try {
    for (let path = thumbQueue.shift(); path !== undefined; path = thumbQueue.shift()) {
      await makeThumb($, path)
    }
  } finally {
    isMakingThumbs = false
  }
}

// How many of the newest paths the band skips. The middle button held over a path and dragged
// left brings older paths in, dragged right newer ones, a path per DRAG_STEP columns.
// A new reply brings the band back to the newest.
const DRAG_STEP = 3
let skipped = 0
let skippedMax = 0
let repliesSeen = -1
// While the middle button is held: how many the band skipped at the press.
let grabbedAt: number | undefined

// What "Read from Claude" found: Claude's own settings that match these, filled in where they do.
let claudeNote = ''

// A language as Claude's settings may name it (`language`: "german", "Deutsch", "de" ...).
const LANGUAGE_WORDS: Record<Language, RegExp> = {
  en: /^(en|eng|english|englisch)\b/i,
  es: /^(es|spa|spanish|español|espanol|spanisch)\b/i,
  zh: /^(zh|chinese|中文|chinesisch|mandarin)/i,
  fr: /^(fr|french|français|francais|französisch|franzoesisch)\b/i,
  uk: /^(uk|ukrainian|українська|ukrainisch)/i,
  ja: /^(ja|japanese|日本語|japanisch)/i,
  ko: /^(ko|korean|한국어|koreanisch)/i,
  de: /^(de|ger|german|deutsch)\b/i,
}

async function readClaude($: Engine) {
  const filled: Partial<Settings> = {}
  const notes: string[] = []
  try {
    const read = await $.settings.read()
    const model = String(read.advisorModel ?? '').toLowerCase()
    const known = MODELS.find(one => model.includes(one))
    if (known !== undefined) {
      filled.advisorModel = known
      notes.push('advisor ' + MODEL_NAMES[known])
    } else {
      notes.push('no advisor model set')
    }
    const word = String(read.language ?? '').trim()
    const language = word === '' ? undefined : LANGUAGES.find(one => LANGUAGE_WORDS[one].test(word))
    if (language !== undefined) {
      filled.language = language
      notes.push('language ' + LANGUAGE_NAMES[language])
    } else {
      notes.push(word === '' ? 'no language set' : 'language "' + word + '" not in the list')
    }
    const isAuto = read.autoCompactEnabled !== false
    let at = ''
    try {
      const { context } = await $.session.usage({ breakdown: 'summary' })
      const breakdown = context.breakdown
      if (isAuto && breakdown?.autoCompactThreshold !== undefined && breakdown.rawMaxTokens > 0) {
        at = ' at ' + Math.round((100 * breakdown.autoCompactThreshold) / breakdown.rawMaxTokens) + ' %'
      }
    } catch {
      // the threshold stays unsaid
    }
    notes.push('auto-compact ' + (isAuto ? 'on' + at : 'off'))
  } catch (error) {
    notes.push('settings not readable: ' + String(error).slice(0, 80))
  }
  notes.push('cache time not readable by mods, cache minutes left as they are')
  claudeNote = 'Claude: ' + notes.join(' · ')
  await saveSettings($, filled)
  $.ui.toast(Object.keys(filled).length === 0 ? 'Nothing to fill in from Claude.' : 'Filled in from Claude: ' + Object.keys(filled).join(', ') + '.')
}

// The settings pane, kept small: a switch per option (each its own colour), the explanations behind a
// small (i) that shows them while the pointer is on it (a click keeps one open), the timings below a line.
let isChoosingLanguage = false
let isChoosingIcon = false
type Toggle = 'thumb' | 'advisor' | 'custom' | 'compact' | 'handover' | 'previews' | 'symbols'
const TOGGLES: readonly Toggle[] = ['thumb', 'advisor', 'custom', 'compact', 'handover', 'previews', 'symbols']
const TOGGLE_COLOURS: Record<Toggle, string> = {
  thumb: '#f5a524', advisor: '#8e4ec6', custom: '#d6409f', compact: '#3e7bd6', handover: '#30a46c', previews: '#12a594', symbols: '#e54666',
}
const INFO = {
  programs: 'The full path of a program, or the name of one found on this computer; Enter saves. Empty: the system\'s default app. Markdown and text files open in a pane of this chat.',
  previews: 'Small previews of images and videos on their path buttons.',
  symbols: 'A symbol for the file type on each path button.',
  textRoom: 'How many characters the hover text in the band keeps at least.',
  thumb: 'The thumb sends a short answer as if you had typed it, in the language of the flag. Each language keeps its own text; empty, its default. A right click on the thumb opens these settings.',
  advisor: '⌾ runs /advisor. The model here is the one of new chats; a right click on ⌾ changes it for one chat.',
  compact: 'The cache button: its grey field is the prompt cache\'s time left, pale with zz once it has run out. A click renews the cache now; a right click turns auto-renew on or off for this chat (a red dot).',
  handover: 'The context button: its grey field is the context still free; the symbol turns green at 20 %, blue at 33 %, orange at 50 %, red at 75 %. A click runs its mode; a right click shows the modes (Compact, Handover, Handover, Log & Clear) and the switch for compact when idle (a red dot).',
  custom: 'A button of your own between ⌾ and the cache. A click opens what "Opens" names: a web address, a file or a folder. When the address does not answer and "Starts if needed" names a command or a .cmd/.bat/.sh file, that runs first, hidden, and the button waits for the address (up to 40 s, an orange dot meanwhile). The symbol is picked from a list. A right click on the button opens these settings.',
  idle: 'Compact when idle: after a reply, with nothing new for these minutes, the chat is compacted if at least this much of its context is used. On or off per chat, with a right click on the context button.',
  cache: 'How long the prompt cache holds after a reply. This only sets the display and auto-renew; it does not change Claude\'s prompt cache.',
  claude: 'Fills in what Claude\'s own settings hold: the advisor model and the language. Mods cannot read the cache time.',
  renew: 'Auto-renew: this many minutes before the cache clock runs out, a short message keeps the cache alive. Each costs a cache read and a short reply; after this many in a row it waits for your next message.',
} as const
type Info = keyof typeof INFO
// The (i) under the pointer, and the ones a click keeps open.
let infoHovered: Info | undefined
const infoKept = new Set<Info>()

function switchDrawing(isOn: boolean, colour: string) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 16">' +
    '<rect x="0.5" y="0.5" width="29" height="15" rx="7.5" fill="' + (isOn ? colour : '#e4e4e4') + '" stroke="' + (isOn ? colour : '#d0d0d0') + '"/>' +
    '<circle cx="' + (isOn ? 22 : 8) + '" cy="8" r="5.6" fill="#fff"/></svg>'
}
function infoDrawing(isOpen: boolean) {
  const colour = isOpen ? '#3e7bd6' : '#9a9a9a'
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="none" stroke="' +
    (isOpen ? colour : '#b4b4b4') + '" stroke-width="1"/>' +
    '<circle cx="7" cy="4.1" r="0.85" fill="' + colour + '"/><rect x="6.35" y="5.9" width="1.3" height="4.6" rx="0.6" fill="' + colour + '"/></svg>'
}
const LINE = '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1" viewBox="0 0 2000 1"><rect width="2000" height="1" fill="#e4e4e4"/></svg>'

// The switches and the (i) report through their hover regions (hover.tsx), as the band's buttons do.
function settingsMessage($: Engine, data: { action?: string; id?: string } | undefined) {
  const id = data?.id
  if (typeof id !== 'string') {
    return false
  }
  if (id.startsWith('set:')) {
    const key = id.slice(4) as Toggle
    if (data?.action === 'press' && TOGGLES.includes(key)) {
      $.clock.after(0, () => void saveSettings($, { [key]: !settings[key] }))
    }
    return true
  }
  if (id.startsWith('icon:')) {
    const icon = id.slice(5) as CustomIcon
    if (data?.action === 'press' && CUSTOM_ICON_LIST.includes(icon)) {
      isChoosingIcon = false
      $.clock.after(0, () => void saveSettings($, { customIcon: icon }))
    } else if (data?.action === 'press' && icon === ('open' as string)) {
      isChoosingIcon = !isChoosingIcon
      $.ui.invalidate('ui.render')
    }
    return true
  }
  if (id.startsWith('info:')) {
    const key = id.slice(5) as Info
    if (!(key in INFO)) {
      return true
    }
    if (data?.action === 'enter') {
      infoHovered = key
    } else if (data?.action === 'leave' && infoHovered === key) {
      infoHovered = undefined
    } else if (data?.action === 'press') {
      if (infoKept.has(key)) {
        infoKept.delete(key)
      } else {
        infoKept.add(key)
      }
    }
    $.ui.invalidate('ui.render')
    return true
  }
  return false
}

function settingsPane($: Engine, ui: any, found: string[]) {
  const { Box, Text, Input, Button, Select, Svg, Client } = ui
  const isDrawn = Svg !== undefined && Client !== undefined
  const systemApp = platform === 'mac' ? 'Finder / default app' : platform === 'linux' ? 'default app (xdg-open)' : 'Explorer / default app'
  const region = (id: string, drawing: string, alt: string, wide: number, high: number) => (
    <Box key={'region-' + id} position="relative" flexShrink={0}>
      <Svg key={'look-' + id} source={drawing} alt={alt} width={wide} height={high} />
      <Box position="absolute" top={0} left={0} right={0} bottom={0}>
        <Client key={'hover-' + id} module="./hover.tsx" props={{ id }} width="100%" height="100%" />
      </Box>
    </Box>
  )
  const isOpen = (key: Info) => infoHovered === key || infoKept.has(key)
  const info = (key: Info) => isDrawn ? region('info:' + key, infoDrawing(isOpen(key)), 'info', 14, 14) : undefined
  const infoText = (keys: Info[], extra = '') => {
    const shown = keys.filter(isOpen)
    return shown.length === 0 ? undefined : (
      <Box key={'info-text-' + keys.join('-')} flexDirection="column" marginLeft="md">
        {shown.map(key => <Text key={'info-line-' + key} dimColor size="footnote">{INFO[key] + (key === 'programs' ? extra : '')}</Text>)}
      </Box>
    )
  }
  const row = (key: string, ...children: any[]) => (
    <Box key={'row-' + key} flexDirection="row" alignItems="center" gap="sm" flexWrap="wrap">{children.filter(child => child !== undefined && child !== false && child !== null)}</Box>
  )
  // Every switch in a column of one width, so the switches of the rows stand under each other.
  const TOGGLE_WIDTH = 24
  const toggle = (key: Toggle, text: string, glyph?: any) => (
    <Box key={'toggle-' + key} flexDirection="row" alignItems="center" gap="sm" width={TOGGLE_WIDTH} flexShrink={0}>
      {isDrawn
        ? region('set:' + key, switchDrawing(settings[key], TOGGLE_COLOURS[key]), text + (settings[key] ? ' on' : ' off'), 30, 16)
        : <Select key={key} options={[{ value: 'on', label: 'on' }, { value: 'off', label: 'off' }]} value={settings[key] ? 'on' : 'off'}
            onSelect={(value: string) => void saveSettings($, { [key]: value === 'on' })} />}
      {glyph}
      <Text key={'label-' + key} dimColor={!settings[key]}>{text}</Text>
      {info(key as Info)}
    </Box>
  )
  // A short field for a number, in a box of a few cells so several stand in a row.
  const number = (key: 'textRoom' | 'idleMinutes' | 'idlePercent' | 'cacheMinutes' | 'renewLead' | 'renewMax') => (
    <Box key={'box-' + key} width={15} flexShrink={0}>
      <Input key={key} value={String(settings[key])} submitLabel="✓" onSubmit={(value: string) => void saveNumber($, key, value)} />
    </Box>
  )
  const words = (key: string, text: string) => <Text key={'w-' + key} dimColor>{text}</Text>
  // The programs: the labels in one column, so the fields start at one edge.
  const program = (key: 'folderApp' | 'mediaApp' | 'threeDApp', text: string) => row(key,
    <Box key={'label-' + key} width={18} flexShrink={0}><Text dimColor>{text}</Text></Box>,
    <Input key={key} value={settings[key]} placeholder={systemApp} submitLabel="save"
      onSubmit={(value: string) => void saveSettings($, { [key]: value.trim() })} />,
  )
  const flag = (one: Language) => Svg === undefined
    ? undefined
    : <Svg key={'flag-' + one} source={FLAGS[one]} alt={LANGUAGE_NAMES[one]} width={21} height={14} />
  const now = settings.language
  const thumbGlyph = Svg === undefined ? <Text key="thumb-glyph">👍</Text> : <Svg key="thumb-glyph" source={THUMB} alt="thumb" width={16} height={16} />

  return (
    <Box flexDirection="column" gap="md">
      {row('h-programs', <Text key="t" bold>Programs</Text>, info('programs'))}
      {infoText(['programs'], found.length > 0 ? ' Found: ' + found.join(' · ') : '')}
      {program('folderApp', 'Folders')}
      {program('mediaApp', 'Images and videos')}
      {program('threeDApp', '3D files')}

      <Text bold>Buttons</Text>
      {row('band', toggle('previews', 'Previews'), toggle('symbols', 'File symbols'))}
      {infoText(['previews', 'symbols'])}
      {row('buttons', toggle('advisor', 'Advisor'), toggle('compact', 'Cache'), toggle('handover', 'Context window'))}
      {infoText(['advisor', 'compact', 'handover'])}
      {row('custom', toggle('custom', 'Custom'),
        settings.custom && words('custom-name', 'named'),
        settings.custom && (
          <Box key="box-customName" width={22} flexShrink={0}>
            <Input key="customName" value={settings.customName} placeholder="Flowchart" submitLabel="✓"
              onSubmit={(value: string) => void saveSettings($, { customName: value.trim() })} />
          </Box>
        ),
        settings.custom && words('custom-symbol', 'symbol'),
        settings.custom && isDrawn && region('icon:open', customField(customIcon(), false), CUSTOM_ICON_NAMES[customIcon()], 19, 18),
        settings.custom && (
          <Button key="icon-open" plain dimColor label={(isDrawn ? '' : CUSTOM_ICON_NAMES[customIcon()] + ' ') + (isChoosingIcon ? '▴' : '▾')} onPress={() => {
            isChoosingIcon = !isChoosingIcon
            $.ui.invalidate('ui.render')
          }} />
        ))}
      {settings.custom && isChoosingIcon && (
        <Box key="icons" flexDirection="row" flexWrap="wrap" gap="md" marginLeft="md">
          {CUSTOM_ICON_LIST.map(icon => (
            <Box key={'icon-' + icon} flexDirection="row" alignItems="center" gap="xs">
              {isDrawn && region('icon:' + icon, customField(icon, false), CUSTOM_ICON_NAMES[icon], 25, 24)}
              <Button key={'pick-icon-' + icon} plain dimColor={icon !== customIcon()} label={CUSTOM_ICON_NAMES[icon]} onPress={() => {
                isChoosingIcon = false
                $.clock.after(0, () => void saveSettings($, { customIcon: icon }))
              }} />
            </Box>
          ))}
        </Box>
      )}
      {settings.custom && row('customOpen',
        <Box key="label-customOpen" width={18} flexShrink={0}><Text dimColor>Opens</Text></Box>,
        <Input key="customOpen" value={settings.customOpen} placeholder="http://localhost:8791 or a path" submitLabel="save"
          onSubmit={(value: string) => void saveSettings($, { customOpen: value.trim() })} />)}
      {settings.custom && row('customStart',
        <Box key="label-customStart" width={18} flexShrink={0}><Text dimColor>Starts if needed</Text></Box>,
        <Input key="customStart" value={settings.customStart} placeholder="a command or a .cmd file (optional)" submitLabel="save"
          onSubmit={(value: string) => void saveSettings($, { customStart: value.trim() })} />)}
      {infoText(['custom'])}
      {settings.advisor && row('advisor-models', words('advisor-model', 'Default:'),
        ...MODELS.map(model => (
          <Button key={'advisor-' + model} plain dimColor={model !== settings.advisorModel} label={MODEL_NAMES[model]} onPress={() => {
            $.clock.after(0, () => void saveSettings($, { advisorModel: model }))
          }} />
        )))}
      {row('thumb', toggle('thumb', 'Thumb', thumbGlyph),
        settings.thumb && words('sends', 'sends'),
        settings.thumb && (
          <Input key={'thumbText-' + now} value={settings.thumbTexts[now] ?? ''} placeholder={YES[now]} submitLabel="save"
            onSubmit={(value: string) => void saveSettings($, { thumbTexts: { ...settings.thumbTexts, [now]: value.trim() } })} />
        ),
        settings.thumb && flag(now),
        settings.thumb && (
          <Button key="language-open" plain dimColor label={LANGUAGE_NAMES[now] + (isChoosingLanguage ? '  ▴' : '  ▾')} onPress={() => {
            isChoosingLanguage = !isChoosingLanguage
            $.ui.invalidate('ui.render')
          }} />
        ))}
      {infoText(['thumb'])}
      {settings.thumb && isChoosingLanguage && (
        <Box key="languages" flexDirection="row" flexWrap="wrap" gap="md" marginLeft="md">
          {LANGUAGES.map(one => (
            <Box key={'language-' + one} flexDirection="row" alignItems="center" gap="xs">
              {flag(one)}
              <Button key={'pick-' + one} plain dimColor={one !== now} label={LANGUAGE_NAMES[one]} onPress={() => {
                isChoosingLanguage = false
                $.clock.after(0, () => void saveSettings($, { language: one }))
              }} />
            </Box>
          ))}
        </Box>
      )}
      {row('textRoom', words('room', 'Hover text room'), number('textRoom'), words('room-chars', 'characters'), info('textRoom'))}
      {infoText(['textRoom'])}

      {Svg !== undefined && <Svg key="line" source={LINE} alt="line" height={1} />}
      <Text bold>Timings</Text>
      {row('idle', words('idle-a', 'Auto-Compact after'), number('idleMinutes'), words('idle-b', 'idle min, if'), number('idlePercent'),
        words('idle-c', '% of the context are used'), info('idle'))}
      {infoText(['idle'])}
      {row('cache', words('cache-a', 'Cache clock'), number('cacheMinutes'), words('cache-b', 'min'), info('cache'),
        <Button key="read-claude-button" plain dimColor label="↻ Read from Claude" onPress={() => {
          $.clock.after(0, () => void readClaude($))
        }} />,
        info('claude'))}
      {infoText(['cache', 'claude'])}
      {claudeNote !== '' && <Text dimColor size="footnote">{claudeNote}</Text>}
      {row('renew', words('renew-a', 'Auto-Renew cache'), number('renewLead'), words('renew-b', 'min before, at most'), number('renewMax'),
        words('renew-c', 'times in a row'), info('renew'))}
      {infoText(['renew'])}

      <Text dimColor size="caption">{(platform === '' ? 'unknown' : platform) + (base === '' ? '' : ' · ' + base)}</Text>
    </Box>
  )
}

// The path under the pointer in the band, if any: its file name shows dim beside the buttons.
let hovered: string | undefined
// A short note after a right click copied a path; it stands where the hovered name would.
let copiedNote: string | undefined

// The settings pane, from /bright-buttons and a right click on the thumb.
async function openSettings($: Engine) {
  await resolvePlatform($)
  await loadSettings($)
  await resolvePrograms($)
  await $.ui.open({ id: SETTINGS, title: 'Bright buttons' })
}

export const register: Register = on => {
  registerHandoff(on)

  // /bright-buttons opens the settings pane.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'bright-buttons', description: 'Settings of the bright buttons: programs, band, thumb, advisor, compact, handover, language' })
    await registerCommands($)
    await loadSettings($)
    return next(e)
  })

  on('command.run', { command: 'bright-buttons' }, async $ => {
    await openSettings($)
    return { text: 'Bright buttons settings opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => {
    await resolvePlatform($)
    await loadSettings($)
    await resolvePrograms($)
    const ui = $.ui.resolve(e) as any
    const found = [OPUS !== '' ? 'Directory Opus: ' + OPUS : '', CHAOS_PLAYER !== '' ? 'Chaos Player: ' + CHAOS_PLAYER : '', F3D !== '' ? 'F3D: ' + F3D : ''].filter(line => line !== '')
    // Should drawing the pane fail, it says why instead of staying empty.
    try {
      return settingsPane($, ui, found)
    } catch (error) {
      await log($, 'settings pane error: ' + String((error as any)?.stack ?? error))
      return <ui.Text>{'The settings could not be drawn: ' + String(error)}</ui.Text>
    }
  })

  // The band's path regions (hit.tsx) post a left click as `open`, a right click as `show`,
  // and the middle button's press, drag and release.
  on('ui.message', async ($, e, next) => {
    const data = (e as any).data as { action?: string; path?: string; id?: string; dx?: number } | undefined
    if (handoffMessage($, data) || settingsMessage($, data)) {
      return {}
    }
    const path = data?.path
    if (typeof path !== 'string') {
      return next(e)
    }
    if (data?.action === 'grab' || data?.action === 'drag') {
      // A drag whose press was not delivered (one post a frame) starts from where the band stands.
      if (data.action === 'grab' || grabbedAt === undefined) {
        grabbedAt = skipped
      }
      const steps = data.action === 'drag' ? Math.round(-(data.dx ?? 0) / DRAG_STEP) : 0
      const moved = Math.min(skippedMax, Math.max(0, grabbedAt + steps))
      if (moved !== skipped || data.action === 'grab') {
        skipped = moved
        $.ui.invalidate('ui.render')
      }
    } else if (data?.action === 'release') {
      grabbedAt = undefined
      $.ui.invalidate('ui.render')
    } else if (data?.action === 'enter' || data?.action === 'leave') {
      const nextHovered = data.action === 'enter' ? path : hovered === path ? undefined : hovered
      if (nextHovered !== hovered) {
        hovered = nextHovered
        $.ui.invalidate('ui.render')
      }
    } else if (data?.action === 'show') {
      // Right click: the full path goes to the clipboard, a dim note in the band says so for a moment.
      const copied = await $.ui.copy({ text: path, surface: e.surface })
      if (!copied.isCopied) {
        $.ui.toast('Could not copy: ' + path)
        return {}
      }
      copiedNote = 'Path copied'
      $.ui.invalidate('ui.render')
      const note = copiedNote
      $.clock.after(1500, () => {
        if (copiedNote === note) {
          copiedNote = undefined
          $.ui.invalidate('ui.render')
        }
      })
    } else if (data?.action === 'open') {
      $.clock.after(0, () => void open($, path))
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: VIEWER }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    if (viewing === undefined) {
      return <Text dimColor>No file open.</Text>
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>{viewing.path}</Text>
        {viewing.isMarkdown ? <Markdown text={viewing.text} /> : <Text>{viewing.text}</Text>}
      </Box>
    )
  })

  // Paths in the transcript get their dot in front.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    await syncBase($)
    // A code block has a copy button, so no dot goes inside it: its dots stand on a
    // line above, in the order of its paths. Everywhere else the dot sits before the path,
    // which shows only as its file name (a folder with its parent); the button keeps the full path.
    const dotted = (whole: string, quoted?: string, bare?: string) => {
      const raw = quoted ?? bare ?? ''
      const path = absolute(raw)
      if (path.length <= 3) {
        return whole
      }
      const tail = quoted === undefined ? (raw.match(/[.,;:!]+$/)?.[0] ?? '') : ''
      // A last part without an extension is a folder: it shows with its parent, as many folders share a name.
      const parts = partsOf(path)
      const isFolder = !/\.[A-Za-z0-9]{1,5}$/.test(parts[parts.length - 1] ?? '')
      const name = parts.slice(isFolder ? -2 : -1).join(sepOf(path)) || path
      return `${markFor(path)} \`${name}\`${tail}`
    }
    // Marked paths wait as placeholders, so the relative pass cannot match a shortened name again.
    const inline = (part: string) => {
      const done: string[] = []
      // PATH has three groups (quoted, bare drive path, bare POSIX path), REL two; past them come
      // the offset (a number) and the text.
      const park = (...args: unknown[]) => {
        const group = (i: number) => (typeof args[i] === 'string' ? (args[i] as string) : undefined)
        const marked = dotted(args[0] as string, group(1), group(2) ?? group(3))
        if (marked === args[0]) {
          return marked as string
        }
        done.push(marked)
        return `\u0000${done.length - 1}\u0000`
      }
      return part
        .replace(PATH, park)
        .replace(REL, park)
        .replace(/\u0000(\d+)\u0000/g, (_, i) => done[Number(i)] ?? '')
    }
    const text = e.props.text
      .split(/(^```[^\n]*\n[\s\S]*?^```[^\n]*$)/m)
      .map((part, i) =>
        i % 2 === 0 ? inline(part) : (() => {
          const dots = pathsOf(part).map(markFor)
          return dots.length === 0 ? part : dots.join(' ') + '\n\n' + part
        })(),
      )
      .join('')
    return next(text === e.props.text ? e : { ...e, props: { ...e.props, text } })
  })

  // The band: the thumb at the left end, the paths, then ⌾, C and H (handoff.tsx). A survey or choice
  // box holds the band: the paths go on a row above it, the box stays untouched, the other buttons wait.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await syncBase($)
    await loadSettings($)
    const ui = $.ui.resolve(e) as any
    const hasButtons = settings.thumb || settings.advisor || settings.compact || settings.handover
    const messages = await $.session.messages()
    // Every path of the chat, newest reply first (at most a few hundred); the band shows seven of
    // them, newest on the left, from where a middle-button drag has moved it.
    const replies = messages.filter(message => message.role === 'assistant')
    if (replies.length !== repliesSeen) {
      repliesSeen = replies.length
      skipped = 0
    }
    const all: string[] = []
    for (const message of [...replies].reverse()) {
      for (const path of pathsOf(message.text).reverse()) {
        if (!all.some(known => known.toLowerCase() === path.toLowerCase())) {
          all.push(path)
        }
      }
      if (all.length >= 300) {
        break
      }
    }
    // As many paths as fit beside the room kept for the name: a narrow band shows fewer,
    // the oldest of the seven left out, so nothing pushes the name past the band's left edge.
    const fitting = (from: number) => {
      let room = (e.props.bodyColumns ?? 200) - settings.textRoom - othersRoom() - (from > 0 ? 6 : 0)
      let count = 0
      for (const path of all.slice(from, from + MAX_BUTTONS)) {
        room -= columnsOf(path)
        if (room < 0 && count > 0) {
          break
        }
        count += 1
      }
      return count
    }
    skippedMax = Math.max(0, all.length - fitting(0))
    skipped = Math.min(skipped, skippedMax)
    const paths = all.slice(skipped, skipped + fitting(skipped))
    if (paths.length === 0) {
      return e.props.hasSurvey || !hasButtons ? next(e) : handoffBand($, e, ui, null)
    }

    const { Box, Button, Text, Svg, Client } = ui
    // Images and videos show as a pale grey preview with bars in their symbol's colour; until the
    // preview is ready (or when it cannot be made) the symbol stands in.
    const previewOf = (path: string, i: number) => {
      if (Svg === undefined || !settings.previews || !MEDIA.test(path)) {
        return null
      }
      const key = path.toLowerCase()
      const thumb = thumbs.get(key)
      if (thumb === undefined) {
        if (!thumbsPending.has(key) && !thumbsFailed.has(key)) {
          thumbsPending.add(key)
          thumbQueue.push(path)
          if (!isMakingThumbs) {
            isMakingThumbs = true
            $.clock.after(0, () => void makeThumbs($))
          }
        }
        return null
      }
      const symbol = dotFor(path)
      const colour = FRAMES[colours.get(key) ?? 0] ?? '#b0b0b0'
      const bar = Math.max(2, Math.round(thumb.height * 0.13))
      const width = Math.max(1, Math.round((THUMB_DRAWN * thumb.width) / Math.max(1, thumb.height)))
      const data = 'data:image/jpeg;base64,' + thumb.jpg
      const source =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `width="${thumb.width}" height="${thumb.height}" viewBox="0 0 ${thumb.width} ${thumb.height}">` +
        // A pale grey picture with round corners and a bar in the symbol's colour at top and bottom.
        `<clipPath id="round"><rect width="${thumb.width}" height="${thumb.height}" rx="6.5"/></clipPath>` +
        `<image width="${thumb.width}" height="${thumb.height}" href="${data}" xlink:href="${data}" clip-path="url(#round)"/>` +
        `<g clip-path="url(#round)" fill="${colour}"><rect width="${thumb.width}" height="${bar}"/>` +
        `<rect y="${thumb.height - bar}" width="${thumb.width}" height="${bar}"/></g></svg>`
      return <Svg key={'look-' + i} source={source} alt={symbol + ' ' + nameOf(path)} width={width} height={THUMB_DRAWN} />
    }
    // Blender files, text files and folders show a flat symbol in their colour; a click works as on a dot.
    const iconOf = (path: string, i: number) => {
      const icon = Svg === undefined || Client === undefined || !settings.symbols ? undefined : ICONS.find(one => one.test(path))
      if (icon === undefined) {
        return null
      }
      const colour = FRAMES[colours.get(path.toLowerCase()) ?? 0] ?? '#b0b0b0'
      const source =
        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${icon.draw(colour)}</svg>`
      return <Svg key={'look-' + i} source={source} alt={dotFor(path) + ' ' + nameOf(path)} width={ICON_DRAWN} height={ICON_DRAWN} />
    }
    // Every path the same frame: its look (preview, symbol or dot), and over it an invisible
    // region of hit.tsx that takes the clicks and the middle-button drag. The same shape for
    // all keeps the held region alive while a drag swaps the looks beneath it.
    // Nothing in it shrinks, so the hovered name beside it cannot squeeze or shift it.
    const slotOf = (path: string, i: number) => {
      if (Client === undefined) {
        return (
          <Button key={'path-' + i} label={dotFor(path)} plain onPress={() => {
            $.clock.after(0, () => void open($, path))
          }} />
        )
      }
      const preview = previewOf(path, i)
      const look = preview ?? iconOf(path, i) ?? <Text key={'look-' + i}>{dotFor(path)}</Text>
      return (
        <Box key={'slot-' + i} position="relative" flexShrink={0} marginLeft="xs" marginRight={preview === null ? 'xs' : undefined}>
          {look}
          <Box key={'over-' + i} position="absolute" top={0} left={0} right={0} bottom={0}>
            <Client key={'hit-' + i} module="./hit.tsx" props={{ path, label: ' ' }} width="100%" height="100%" />
          </Box>
        </Box>
      )
    }
    const name = (copiedNote !== undefined || (hovered !== undefined && paths.includes(hovered)))
      ? (copiedNote ?? (hovered === undefined ? '' : nameOf(hovered)))
      : ''
    const leftOver = (e.props.bodyColumns ?? 200) - othersRoom() - (skipped > 0 ? 6 : 0) - 3 -
      paths.reduce((sum, path) => sum + columnsOf(path), 0)
    // All the room left of the buttons, so the name starts at the band's left end; where that
    // is more than there is, the box shrinks to fit.
    // The thumb stands at the band's left end (when on, from 64 columns on): the name leaves it room.
    const thumbRoom = thumbFits(e.props.bodyColumns ?? 200) ? THUMB_ROOM : 0
    const nameWidth = Math.max(settings.textRoom, leftOver + 12 - thumbRoom)
    const buttons = (
      <Box justifyContent="flex-end" alignItems="center">
        {/* The hovered name left of the buttons, as wide as the band has room for (the paths shown
            leave at least settings.textRoom); one line only, a long name cut in the middle. */}
        {name !== '' && (
          <Box key="hovered-name" width={nameWidth} flexShrink={1} minWidth={NAME_LEAST} marginRight="md">
            <Text dimColor wrap="truncate-middle">{name}</Text>
          </Box>
        )}
        {/* While the band shows older paths: a grey hand and how many newer ones are left out. */}
        {skipped > 0 && (
          <Box key="skipped" marginRight="sm" flexShrink={0} alignItems="center" gap="xs">
            {Svg !== undefined ? (
              <Svg key="hand" source={HAND} alt="older paths" width={ICON_DRAWN - 4} height={ICON_DRAWN - 4} />
            ) : (
              <Text key="hand">✋</Text>
            )}
            <Text key="count" dimColor>{'+' + skipped}</Text>
          </Box>
        )}
        {paths.map(slotOf)}
      </Box>
    )
    if (e.props.hasSurvey) {
      return (
        <Box flexDirection="column">
          {buttons}
          {await next(e)}
        </Box>
      )
    }
    return handoffBand($, e, ui, buttons)
  })
}
