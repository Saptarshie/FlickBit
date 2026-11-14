/**
 * The one line a card shows before the first touch.
 *
 * `controls` names a mechanism; a player needs to know what their thumb does.
 * "mixed" is accurate and useless. Generated games ship a `hint`; this is the
 * fallback for everything published before the field existed, and it is honest
 * about what each scheme normally means.
 */
export function controlsLegend(controls: string | undefined): string {
  switch ((controls ?? 'tap').toLowerCase()) {
    case 'swipe':
      return 'Swipe to steer';
    case 'drag':
      return 'Drag to aim, release to fire';
    case 'joystick':
      return 'Left thumb on the stick to move';
    case 'buttons':
      return 'Tap the buttons to act';
    case 'mixed':
      return 'Left thumb moves · right thumb acts';
    case 'tilt':
      return 'Tilt your phone to steer';
    case 'keys':
      return 'Arrow keys or WASD';
    default:
      return 'Tap anywhere to play';
  }
}
