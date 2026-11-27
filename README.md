# bright-buttons, a Claude Code mod by gottesgerl

A band above the prompt for Claude Code (desktop app and terminal):

- a coloured button per path from the latest replies, a small preview for images and videos; left click opens, right click copies the path (Windows, macOS and Linux),
- a thumb at the band's left end that types "Yes, please",
- `⌾` for `/advisor`, a custom button of your own that opens an address, file or folder and starts a server first when needed, a cache button (an ice lolly) with the prompt cache's time filling it and an auto-renew that keeps the cache alive, and a context button with the free context filling it that compacts, asks for a handover, or has a handover written and the work moved to a new chat.

Each of the thumb, `⌾`, the custom, the cache and the context button can be switched off in the settings. Until version 0.10 the buttons on the right were a mod of their own, `handoff-button`; it is now part of `bright-buttons`.

## Installation

In a terminal (Claude Code must be installed):

```
claude plugin marketplace add gottesgerl/claude_mod_brightbuttons
claude plugin install bright-buttons@bright-buttons
```

Then restart Claude. The mod runs in every new session, the desktop app included.

Updating to a new version:

```
claude plugin marketplace update bright-buttons
claude plugin update bright-buttons
```

If `handoff-button` is still installed from an earlier version, remove it (`claude plugin uninstall handoff-button`), or its buttons show twice.

If you also load the mod as a folder under `~/.claude/mods/` (`CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`), remove that entry, or the mod runs twice.

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
- **Symbols** in the path's colour: Blender logo (`.blend`), spiral (Houdini `.hip`, `.hda`, `.otl`), `>` (Python and scripts: `.py`, `.ps1`, `.sh`, `.bat`, `.js`, `.ts`, `.tsx`), tree slice (`.log`), gear (data and settings: `.json`, `.yaml`, `.xml`, `.ini`, `.ocio`), wire cube (3D: `.usd`, `.glb`, `.fbx`, `.obj`, `.abc`), page (`.pdf`), network in a disc (models: `.safetensors`, `.ckpt`, `.pt`, `.gguf`, `.onnx`), `#` (spreadsheets: `.xlsx`, `.xls`, `.xlsm`, `.xlsb`, `.csv`, `.tsv`, `.ods`), `//` (`.html`, `.htm`, `.xhtml`), two lines (`.md`, `.txt`), folder, film reel (video, until its preview is ready). Other files keep their dot.
- **Left click** opens the path, **right click** copies the full path to the clipboard ("Path copied" shows for a moment).
- **Hovering** shows the file name dimmed left of the buttons; a narrow band shows fewer paths so the name keeps its room.
- **Older paths:** hold the middle mouse button over a path and drag left for older paths of the chat, right for newer ones While older paths show, a grey hand and a dim `+N` count the newer paths left out. A new reply brings the band back to the newest.

| Path | Opens in |
| --- | --- |
| Folder | the program set for folders, else the system's file manager |
| Image or video (png, jpg, webp, bmp, gif, tif, exr, hdr, tga, dpx, mp4, mov, mkv, avi, webm, m4v, mxf) | the program set for images and videos, else the default app |
| 3D file (glb, gltf, fbx, obj, usd, usda, usdc, usdz, abc, stl, ply, 3mf, dae) | the program set for 3D files, else the default app. Scene files (.blend, .hip) always open in the default app, usually Blender and Houdini |
| `.md`, `.txt` | a pane in Claude, markdown rendered |
| everything else | the system's default app (`explorer` on Windows, `open` on macOS, `xdg-open` on Linux) |

### Settings

`/bright-buttons` opens the settings pane. Switches turn things on or off; an (i) behind a setting explains it on hover, a click keeps the text open.
- **Programs** for folders, for images and videos and for 3D files: the full path of a program (on macOS an `.app` works too). Empty means the system's default app. Directory Opus and the Chaos Player, where installed, are named below as paths to copy. Directory Opus is set with its `dopusrt.exe`; the folder then opens in a tab (an existing one if open) and the window comes forward.
- **Room for the hover text**: the columns kept for the hovered file name and the buttons' hint (10 at first).
- **Buttons**, in three rows:
  - **Previews** of images and videos and **File symbols** (off: dots only), both on at first.
  - **Advisor** (off at first) with **Default:**, the advisor model of new chats (Opus); **Cache** and **Context window** (on).
  - **Custom** (off at first): its name (the hint), its symbol picked from a list (Play at first; Arrows, Wind, Sprig, Power), **Opens** (a web address, a file or a folder) and **Starts if needed** (a command or a `.cmd`, `.bat` or `.sh` file).
  - **Thumb** (on), **sends** a text of your own per language (empty: "Yes, please" in that language), and the **language**, a list with small flags: English, Español, 中文, Français, Українська, 日本語, 한국어, Deutsch.
- **Timings**:
  - **Auto-Compact** after 55 idle minutes, if 50 % of the context is used.
  - **Cache clock**: how long the prompt cache holds after a reply (60 minutes); the cache button's grey field empties over this time. It sets only the display and auto-renew, not Claude's prompt cache. **Read from Claude** fills in what Claude's own settings hold (`advisorModel`, `language`); mods cannot read the cache time.
  - **Auto-Renew cache** 1 minute before the cache clock runs out, at most 2 times in a row before it waits for your next message.

The settings are kept across sessions.

### Relative paths

Relative paths like `blender/shot01/frame.png` are found without any setup when their first folder lies directly in the session's project folder. The mod reads the project's folders for this (again when the project changes and every 30 seconds). Words with a slash that do not start with a project folder stay plain text.

Notes:
- Paths are found as `C:\...` or `C:/...` (Windows), `/Users/...`, `/home/...`, `/Volumes/...`, `/mnt/...` and other usual top folders, and `~/...`. In backticks any absolute path counts. Paths with spaces are found only in backticks.
- To bring Directory Opus forward, a small PowerShell script is written to the temp folder (`bright-buttons-focus-opus.ps1`).

## Thumb, ⌾, custom, cache and context

Four buttons on the right of the band and a thumb at its left end. Hovering shows a short hint right of the thumb, where a hovered file name shows too. A right click sets each button's option.

| Button | Left click | Right click |
| --- | --- | --- |
| `⌾` | runs `/advisor` with the chosen model (the settings' default at first) | shows `Fable Opus Sonnet Haiku` in the band, the other buttons out of the way; a pick turns the advisor on with that model for this chat |
| custom (Play, or the symbol picked) | opens what **Opens** names. When that is a web address that does not answer and **Starts if needed** is set, it runs that first, hidden and on its own (not tied to Claude), and waits up to 40 seconds for the address, an orange dot on the button meanwhile. Example: `http://localhost:8791` with the `.cmd` that starts its local server. Nothing set: the settings open | opens the settings |
| cache (ice lolly) | renews the prompt cache now with a short message from the mod ("Cache keep-alive, nothing to do. Reply with just: ok") | turns **auto-renew** on or off for this chat, shown as a red dot at the top right: shortly before the cache clock runs out the same message keeps the cache alive, each costing a cache read and a short reply. The grey field is an abstract hourglass: the cache time still left fills it from the bottom (the hint names the minutes). The ice lolly melts in four steps as the time runs out: whole, glaze running, sagging, a lump over a puddle. Once the time is up only the puddle is left, pale with a small `zz`: the cache sleeps |
| context (funnel, open hand or sparkle) | runs its mode: the funnel (**Compact**) runs `/compact` at once; the open hand (**Handover**) sends "Bitte schreib ein Handover." as if you had typed it; the sparkle (**Handover & New Chat**) puts "Handover und neuer Chat (Skill handover-next)." into the prompt box, and Enter sends it | shows the three modes in the band and a switch for **compact when idle** (a red dot on the button): after a reply, with nothing new typed for the minutes set, the chat is compacted if enough of its context is used. The field shows the context still free, sinking from the top as the chat grows: grey up to 25 % used, then pale blue, from 50 % pale yellow, from 75 % pale red (the hint names the percent) |
| thumb | sends its text in the chosen language, as if you had typed it | opens the settings |

When the band gets narrow, the thumb goes first.

The advisor model, auto-renew and compact when idle are set per chat: a new chat starts with the settings' advisor model and both off. The context mode stays from chat to chat. Claude Code's own auto-compact setting is left alone.

A right click on the thumb or `/bright-buttons` opens the settings.

**Handover & New Chat** needs a skill named `handover-next` (not part of the mod): it writes the handover file, starts a new chat named one letter up (`… [B]` → `… [C]`) in the same group, pinned only if the old chat is, and the new chat reads the handover and asks with buttons whether the old chat is archived, unpinned or left as it is. The sparkle only fills the prompt box, since the desktop app does not start a new chat from a message a mod sent.

The full handover, **Handover, Log & Clear** (Windows), is hidden in the menu for now. It:
1. exports the chat as `.txt` and `.pdf` to `Documents\Claude Handoffs`,
2. has a handover written and saves it as `….handoff.md` beside the export,
3. renames the chat `… [A]`, clears it with `/clear` and starts it as `… [B]` with the handover (kept on disk until the new chat has it, so a restarted chat still gets it),
4. shows a `<<` button in the new chat that opens the old chat's PDF.

While a reply runs, the handover modes wait until it is done. If `/compact` does not work, a short message appears.

`/import-chat` loads an exported chat into the current chat. The PDF is made by Microsoft Edge in the background; without Edge there is no PDF.
