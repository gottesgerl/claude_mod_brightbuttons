import type { EngineInterface as Engine, Register } from 'claude-code'

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
// An empty program means automatic: Directory Opus and the Chaos Player where installed
// (Windows), else the system's own app.
type Settings = { folderApp: string; mediaApp: string; previews: boolean; symbols: boolean }
const DEFAULTS: Settings = { folderApp: '', mediaApp: '', previews: true, symbols: true }
let settings: Settings = { ...DEFAULTS }
let isSettingsLoaded = false

async function loadSettings($: Engine) {
  if (isSettingsLoaded) {
    return
  }
  isSettingsLoaded = true
  try {
    const stored = (await $.store.get('settings')) as Partial<Settings> | undefined
    settings = { ...DEFAULTS, ...(stored ?? {}) }
  } catch {
    settings = { ...DEFAULTS }
  }
}

async function saveSettings($: Engine, change: Partial<Settings>) {
  settings = { ...settings, ...change }
  await $.store.set('settings', settings)
  $.ui.invalidate('ui.render')
}

// Folders go to Directory Opus, images and videos to the Chaos Player, the rest to the
// system's default app. Each falls back to the default app when not installed.
const OPUS_SUBPATH = '\\GPSoftware\\Directory Opus\\dopusrt.exe'
const CHAOS_SUBPATH = '\\Chaos\\Player\\chaosplayer_qt5.exe'
let OPUS = ''
let CHAOS_PLAYER = ''
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

// Text files (TEXT, above) show in a pane of this chat instead of an outside app.
const VIEWER = 'path-viewer'
const SETTINGS = 'path-buttons-settings'
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
  let command = openDefault(path)
  if (isFolder && settings.folderApp !== '') {
    command = launch(settings.folderApp, path)
  } else if (!isFolder && MEDIA.test(path) && settings.mediaApp !== '') {
    command = launch(settings.mediaApp, path)
  } else if (isFolder && OPUS !== '') {
    // dopusrt talks to the running Opus: jump to the folder in a tab (an existing one if open).
    command = [OPUS, '/cmd', 'Go', path, 'NEWTAB=findexisting']
  } else if (!isFolder && MEDIA.test(path) && CHAOS_PLAYER !== '') {
    command = launch(CHAOS_PLAYER, path)
  }
  try {
    const ran = await $.process.run(command)
    // The exit code of a default app or of a launcher that hands over means nothing,
    // but Opus reporting an error is worth seeing.
    if (command[0] === OPUS && ran.exitCode !== 0) {
      $.ui.toast('Directory Opus: exit ' + ran.exitCode + ' ' + ran.stderr.slice(0, 120))
    }
    if (command[0] === OPUS) {
      // Go switches the tab but leaves the window where it was: bring it forward.
      const script = tempFile('path-buttons-focus-opus.ps1')
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
// The room kept at the band's left for the hovered file name (columns), so it never gets squeezed out.
const TEXT_ROOM = 18
// Columns kept for what other mods put in the band beside the paths (handoff-button's four buttons).
const OTHERS_ROOM = 30
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
    const out = tempFile('path-buttons-thumb-' + (hash >>> 0).toString(16) + '.jpg')
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

// The path under the pointer in the band, if any: its file name shows dim beside the buttons.
let hovered: string | undefined
// A short note after a right click copied a path; it stands where the hovered name would.
let copiedNote: string | undefined

export const register: Register = on => {
  // /path-buttons opens the settings pane.
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'path-buttons', description: 'Settings of the path buttons: programs, previews, symbols' })
    return next(e)
  })

  on('command.run', { command: 'path-buttons' }, async $ => {
    await resolvePlatform($)
    await loadSettings($)
    await resolvePrograms($)
    await $.ui.open({ id: SETTINGS, title: 'Path buttons' })
    return { text: 'Path buttons settings opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS }, async ($, e) => {
    await resolvePlatform($)
    await loadSettings($)
    await resolvePrograms($)
    const { Box, Text, Input, Select } = $.ui.resolve(e) as any
    const systemApp = platform === 'mac' ? 'Finder / default app' : platform === 'linux' ? 'default app (xdg-open)' : 'Explorer / default app'
    const autoFolder = OPUS !== '' ? 'Directory Opus (found)' : systemApp
    const autoMedia = CHAOS_PLAYER !== '' ? 'Chaos Player (found)' : systemApp
    const onOff = [
      { value: 'on', label: 'on' },
      { value: 'off', label: 'off' },
    ]
    return (
      <Box flexDirection="column" gap="sm">
        <Text bold>Programs</Text>
        <Text dimColor>The full path of a program, Enter saves. Empty: automatic.</Text>
        <Input
          key="folderApp"
          label="Folders: "
          value={settings.folderApp}
          placeholder={'automatic: ' + autoFolder}
          submitLabel="save"
          onSubmit={(value: string) => void saveSettings($, { folderApp: value.trim() })}
        />
        <Input
          key="mediaApp"
          label="Images and videos: "
          value={settings.mediaApp}
          placeholder={'automatic: ' + autoMedia}
          submitLabel="save"
          onSubmit={(value: string) => void saveSettings($, { mediaApp: value.trim() })}
        />
        <Text dimColor>Markdown and text files open in a pane of this chat; everything else in the system's default app.</Text>
        <Text bold>Band</Text>
        <Select
          key="previews"
          label="Previews of images and videos: "
          options={onOff}
          value={settings.previews ? 'on' : 'off'}
          onSelect={(value: string) => void saveSettings($, { previews: value === 'on' })}
        />
        <Select
          key="symbols"
          label="Symbols for file types: "
          options={onOff}
          value={settings.symbols ? 'on' : 'off'}
          onSelect={(value: string) => void saveSettings($, { symbols: value === 'on' })}
        />
        <Text dimColor>{'System: ' + (platform === '' ? 'unknown' : platform) + (base === '' ? '' : ' · project: ' + base)}</Text>
      </Box>
    )
  })

  // The band's path regions (hit.tsx) post a left click as `open`, a right click as `show`,
  // and the middle button's press, drag and release.
  on('ui.message', async ($, e) => {
    const data = (e as any).data as { action?: string; path?: string; dx?: number } | undefined
    const path = data?.path
    if (typeof path !== 'string') {
      return {}
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
      const next = data.action === 'enter' ? path : hovered === path ? undefined : hovered
      if (next !== hovered) {
        hovered = next
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

  // The buttons sit left of whatever the band holds beneath (the H button).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    await syncBase($)
    await loadSettings($)
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
      let room = (e.props.bodyColumns ?? 200) - TEXT_ROOM - OTHERS_ROOM - (from > 0 ? 6 : 0)
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
      return below
    }

    const { Box, Button, Text, Svg, Client } = $.ui.resolve(e) as any
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
    const leftOver = (e.props.bodyColumns ?? 200) - OTHERS_ROOM - (skipped > 0 ? 6 : 0) - 3 -
      paths.reduce((sum, path) => sum + columnsOf(path), 0)
    // All the room left of the buttons, so the name starts at the band's left end; where that
    // is more than there is, the box shrinks to fit.
    const nameWidth = Math.max(TEXT_ROOM, leftOver + 12)
    const buttons = (
      <Box justifyContent="flex-end" alignItems="center">
        {/* The hovered name left of the buttons, as wide as the band has room for (the paths shown
            leave at least TEXT_ROOM); one line only, a long name cut in the middle. */}
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
        {!e.props.hasSurvey && below.type !== 'engine' && below}
      </Box>
    )
    // A survey or choice box holds the band: the buttons go on a row above it, the box stays untouched.
    return e.props.hasSurvey ? (
      <Box flexDirection="column">
        {buttons}
        {below}
      </Box>
    ) : (
      buttons
    )
  })
}
