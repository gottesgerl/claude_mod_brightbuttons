# Claude Code mods by gottesgerl

Two mods for Claude Code (desktop app and terminal) that together form a band above the prompt.

| Mod | What it does |
| --- | --- |
| `bright-buttons` | A coloured button per path from the latest replies, a small preview for images and videos. Left click opens, right click copies the path. Windows, macOS and Linux. |
| `handoff-button` | `⌾` runs `/advisor` with the chosen model, `C` runs `/compact` (or compacts by itself when idle), `H` asks for a handover; in full handover mode (`⤓`) it exports the chat, renames it `[A]`, starts a new chat `[B]` with the handover and archives the old one. A thumb types "Yes, please". A right click sets each button's option. Lays the `bright-buttons` row beside its own. Windows. |

Each mod works on its own. With both, the coloured buttons stand left of the H.

## Installation

In a terminal (Claude Code must be installed):

```
claude plugin marketplace add gottesgerl/claude_mod_brightbuttons
claude plugin install bright-buttons@bright-buttons
claude plugin install handoff-button@bright-buttons
```

Then restart Claude. The mods run in every new session, the desktop app included.

Updating to a new version:

```
claude plugin marketplace update bright-buttons
claude plugin update bright-buttons
claude plugin update handoff-button
```

If you also load a mod as a folder under `~/.claude/mods/` (`CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`), remove that entry, or the mod runs twice.

### Let Claude write the paths in full

Buttons appear for absolute paths, and for relative paths that start with a folder of the project. To get them reliably, add this to `~/.claude/CLAUDE.md` (it applies to all projects; create the file if there is none):

```markdown
## Paths in replies as bright buttons

The `bright-buttons` mod turns paths in replies into coloured buttons.

- Write every file and folder as an absolute path in backticks, e.g. `C:\Projects\example\file.png` or `/Users/me/Projects/example/file.png`.
- No markdown links to local files.
- At most 7 paths per reply (the mod has 7 colours), the most important first.
```

## bright-buttons

Every path gets a coloured mark. The same mark stands before the path in the reply and on its button, so it is clear which button belongs to which path. The shape tells the kind:

| Kind | Mark in the text |
| --- | --- |
| Video | heart ❤️🧡💚💙💛💜🤍 |
| Image | square 🟥🟧🟩🟦🟨🟪⬜ |
| everything else | dot 🔴🟠🟢🔵🟡🟣⚪ |

The text shows only the file name (a folder with its parent folder), the button keeps the full path. In code blocks the marks stand on a line above, so the copy button copies the bare path.

The buttons show the paths of the latest replies, newest on the left, at most seven. While a choice box is open they stand on a row above it.

In the band:
- **Images and videos** show as a small, pale black-and-white preview with rounded corners and a bar in their colour at top and bottom. Videos show their frame at one second. The preview is made by `ffmpeg` (looked for in `Program Files\ffmpeg\bin` on Windows, in `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin` elsewhere, else on the PATH) as a small JPEG in the temp folder. Without ffmpeg, or until the preview is ready, a symbol stands in.
- **Symbols** in the path's colour: Blender logo (`.blend`), spiral (Houdini `.hip`, `.hda`, `.otl`), `>` (Python and scripts: `.py`, `.ps1`, `.sh`, `.bat`, `.js`, `.ts`, `.tsx`), tree slice (`.log`), gear (data and settings: `.json`, `.yaml`, `.xml`, `.ini`, `.ocio`), wire cube (3D: `.usd`, `.glb`, `.fbx`, `.obj`, `.abc`), page (`.pdf`), network in a disc (models: `.safetensors`, `.ckpt`, `.pt`, `.gguf`, `.onnx`), two lines (`.md`, `.txt`), folder, film reel (video, until its preview is ready). Other files keep their dot.
- **Left click** opens the path, **right click** copies the full path to the clipboard ("Path copied" shows for a moment).
- **Hovering** shows the file name dimmed left of the buttons; a narrow band shows fewer paths so the name keeps its room.
- **Older paths:** hold the middle mouse button over a path and drag left for older paths of the chat, right for newer ones While older paths show, a grey hand and a dim `+N` count the newer paths left out. A new reply brings the band back to the newest.

| Path | Opens in |
| --- | --- |
| Folder | the program set for folders, else the system's file manager |
| Image or video (png, jpg, webp, bmp, gif, tif, exr, hdr, tga, dpx, mp4, mov, mkv, avi, webm, m4v, mxf) | the program set for images and videos, else the default app |
| 3D file (glb, gltf, fbx, obj, usd, usda, usdc, usdz, abc, stl, ply, 3mf, dae, blend) | the program set for 3D files, else the default app |
| `.md`, `.txt` | a pane in Claude, markdown rendered |
| everything else | the system's default app (`explorer` on Windows, `open` on macOS, `xdg-open` on Linux) |

### Settings

`/bright-buttons` opens the settings pane:
- **Programs** for folders, for images and videos and for 3D files: the full path of a program (on macOS an `.app` works too). Empty means the system's default app. Directory Opus and the Chaos Player, where installed, are named below as paths to copy. Directory Opus is set with its `dopusrt.exe`; the folder then opens in a tab (an existing one if open) and the window comes forward.
- **Previews** of images and videos on or off.
- **Symbols** for file types on or off (off: dots only).
- **Room for the hover text**: the columns kept for the hovered file name (and for handoff-button's hint), 18 at first.
- With `handoff-button`: its settings too (compact when idle, language).

The settings are kept across sessions.

### Relative paths

Relative paths like `blender/shot01/frame.png` are found without any setup when their first folder lies directly in the session's project folder. The mod reads the project's folders for this (again when the project changes and every 30 seconds). Words with a slash that do not start with a project folder stay plain text.

Notes:
- Paths are found as `C:\...` or `C:/...` (Windows), `/Users/...`, `/home/...`, `/Volumes/...`, `/mnt/...` and other usual top folders, and `~/...`. In backticks any absolute path counts. Paths with spaces are found only in backticks.
- To bring Directory Opus forward, a small PowerShell script is written to the temp folder (`bright-buttons-focus-opus.ps1`).

## handoff-button

Three buttons on the right of the band above the prompt and a thumb at its left end. Hovering shows a short hint right of the thumb, where `bright-buttons` shows a file name. A right click sets each button's option.

| Button | Left click | Right click |
| --- | --- | --- |
| `⌾` | runs `/advisor` with the chosen model (Opus at first) | shows `Fable Opus Sonnet Haiku` in the band, the other buttons out of the way; a pick turns the advisor on with that model for this chat |
| `C` | runs `/compact` at once, without asking | turns compact when idle on or off for this chat: after a reply, with nothing new typed for 60 minutes (a setting), the chat is compacted if its context is at least half full; while on, the `C` is a red outline on its grey field. Its grey field doubles as an abstract hourglass: the part of the prompt cache's time (an hour at first, a setting) still left fills it from the bottom a shade darker (the hint names the minutes) |
| `H` | sends "Bitte schreib ein Handover." as if you had typed it | switches to full handover mode: the button shows `⤓`; another right click switches back |
| thumb | sends "Yes, please" in the chosen language, as if you had typed it | opens the settings |

When the band gets narrow, the thumb goes first.

The advisor model and compact when idle are set per chat: a new chat starts with Opus and without compact when idle. The handover mode stays from chat to chat. Claude Code's own auto-compact setting is left alone.

A right click on the thumb or `/handoff-button` opens the settings (with `bright-buttons` its settings pane, which holds both mods' settings; without it a pane of its own):
- compact when idle: the minutes and the percent of context,
- cache minutes: how long the prompt cache holds after a reply (60 at first); the `C`'s grey field empties over this time,
- the language, a list with small flags: English, Español, 中文, Français, Українська, 日本語, 한국어, Deutsch. For now it sets what the thumb sends.

In full handover mode the `⤓` button:
1. exports the chat as `.txt` and `.pdf` to `Documents\Claude Handoffs`,
2. has a handover written,
3. renames the chat `… [A]`, clears it and starts it as `… [B]` with the handover,
4. shows a `<<` button in the new chat that opens the old chat's PDF.

While a reply runs, `H` waits until it is done. If `C` does not work, a short message appears.

`/import-chat` loads an exported chat into the current chat. The PDF is made by Microsoft Edge in the background; without Edge there is no PDF.

Since Claude Code 2.1.325 every mod gets its own row in the band; `handoff-button` lays the rows side by side again.
