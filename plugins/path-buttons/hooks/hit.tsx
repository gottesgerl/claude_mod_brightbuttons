import type { ClientModule } from 'claude-code'

// One path's pressable region in the band: over a symbol, a dot or a preview.
// Left click opens the path, right click copies it; the hooks module does both on the post.
// The middle button held and dragged sideways pages the band: the region keeps the pointer until
// the button comes up and posts the columns dragged since the press; the hooks module moves the band.
type Props = { path: string; label: string }
type State = { grabX: number }

const Hit: ClientModule<Props, State | undefined> = (props, surface) => {
  const { Text } = surface.elements
  // Set again on every call, so the listener always knows the path drawn now.
  surface.onPointer(event => {
    // Over and away: the hooks module shows the file name dim in the band meanwhile.
    if (event.type === 'enter' || event.type === 'leave') {
      surface.post({ action: event.type, path: props.path })
      return
    }
    const x = event.fine?.x ?? event.x
    // The hold ends with any button coming up, or a move with none held (it came up elsewhere).
    if (surface.state !== undefined && (event.type === 'up' || (event.type === 'move' && event.button === undefined))) {
      surface.setState(undefined)
      surface.post({ action: 'release', path: props.path })
      return
    }
    if (event.button === 'middle') {
      if (event.type === 'down') {
        surface.setState({ grabX: x })
        surface.post({ action: 'grab', path: props.path })
      } else if (event.type === 'move' && surface.state !== undefined) {
        surface.post({ action: 'drag', path: props.path, dx: x - surface.state.grabX })
      }
      return
    }
    if (event.type !== 'down') {
      return
    }
    if (event.button === 'right') {
      surface.post({ action: 'show', path: props.path })
    } else if (event.button === 'left') {
      surface.post({ action: 'open', path: props.path })
    }
  })
  return <Text>{props.label}</Text>
}

export default Hit
