// The values the two mods hand each other for the session ($.state): one settings pane for both.
export {}

declare module 'claude-code' {
  interface PluginState {
    'bright-buttons': {
      // From bright-buttons' settings pane. A handoff field left out is handoff-button's own value.
      shared: { textRoom: number; idleMinutes?: number; idlePercent?: number; language?: string }
    }
    'handoff-button': {
      // handoff-button's own values and its languages (name, flag drawing, the thumb's answer).
      settings: {
        idleMinutes: number
        idlePercent: number
        language: string
        languages: { id: string; name: string; flag: string; yes: string }[]
      }
    }
  }
}
