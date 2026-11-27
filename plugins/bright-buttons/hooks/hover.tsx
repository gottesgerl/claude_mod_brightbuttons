import type { ClientModule } from 'claude-code'

// An invisible region over one of the band's buttons: it reports the pointer coming and going
// (the hooks module shows a short dim hint meanwhile), a left click (the button's action) and a
// right click (the button's option: advisor model, auto-compact, handover mode) and a middle click
// (the cache's auto-renew on or off, the context's next mode).
type Props = { id: string }

const Hover: ClientModule<Props> = (props, surface) => {
  const { Text } = surface.elements
  surface.onPointer(event => {
    if (event.type === 'enter' || event.type === 'leave') {
      surface.post({ action: event.type, id: props.id })
    } else if (event.type === 'down' && event.button === 'left') {
      surface.post({ action: 'press', id: props.id })
    } else if (event.type === 'down' && event.button === 'right') {
      surface.post({ action: 'menu', id: props.id })
    } else if (event.type === 'down' && event.button === 'middle') {
      surface.post({ action: 'cycle', id: props.id })
    }
  })
  return <Text>{' '}</Text>
}

export default Hover
