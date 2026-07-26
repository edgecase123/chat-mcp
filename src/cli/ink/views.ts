export type View =
  | { kind: 'home' }
  | { kind: 'dm'; peer: string }
  | { kind: 'room'; room: string }
  | { kind: 'who' }
  | { kind: 'help' }
  | { kind: 'rooms' };
