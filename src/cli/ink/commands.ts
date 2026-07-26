export type Category = 'conversation' | 'messaging' | 'status' | 'system';

export const CATEGORIES: Category[] = ['conversation', 'messaging', 'status', 'system'];

export const CATEGORY_LABELS: Record<Category, string> = {
  conversation: 'CONVERSATION',
  messaging: 'MESSAGING',
  status: 'STATUS & OBSERVATION',
  system: 'SYSTEM',
};

export type ArgKind = 'peer' | 'room' | 'target' | 'status' | 'text' | 'none';

export interface CommandArg {
  name: string;
  kind: ArgKind;
  optional?: boolean;
  variadic?: boolean;
}

export interface Command {
  name: string;
  args: CommandArg[];
  description: string;
  category: Category;
}

export const COMMANDS: Command[] = [
  { name: '/dm', args: [{ name: 'peer', kind: 'peer' }], description: 'open a DM', category: 'conversation' },
  { name: '/join', args: [{ name: '#room', kind: 'room' }], description: 'join a room', category: 'conversation' },
  { name: '/leave', args: [], description: 'leave current room', category: 'conversation' },
  { name: '/back', args: [], description: 'return to home', category: 'conversation' },
  { name: '/rooms', args: [], description: 'open room browser', category: 'conversation' },

  { name: '/dispatch', args: [{ name: 'peer', kind: 'peer' }, { name: 'text', kind: 'text', variadic: true }], description: 'send tagged [DISPATCH] to peer', category: 'messaging' },
  { name: '/broadcast', args: [{ name: '#room', kind: 'room' }, { name: 'text', kind: 'text', variadic: true }], description: 'send tagged [DISPATCH] to room', category: 'messaging' },
  { name: '/alert', args: [{ name: 'target', kind: 'target' }, { name: 'text', kind: 'text', variadic: true }], description: 'urgent — red banner', category: 'messaging' },
  { name: '/ack', args: [], description: 'dismiss visible alerts', category: 'messaging' },

  { name: '/set-status', args: [{ name: 'status', kind: 'status' }, { name: 'focus', kind: 'text', variadic: true, optional: true }], description: 'set your status + focus', category: 'status' },
  { name: '/who', args: [], description: 'peer table', category: 'status' },
  { name: '/watch', args: [{ name: 'peer', kind: 'peer' }], description: 'mirror another peer\'s traffic', category: 'status' },
  { name: '/unwatch', args: [], description: 'close watch pane', category: 'status' },

  { name: '/help', args: [], description: 'open this help', category: 'system' },
  { name: '/quit', args: [], description: 'quit', category: 'system' },
  { name: '/exit', args: [], description: 'quit', category: 'system' },
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

export function commandsByCategory(cat: Category): Command[] {
  return COMMANDS.filter((c) => c.category === cat);
}

export function argShape(cmd: Command): string {
  return cmd.args
    .map((a) => (a.optional ? `[${a.name}${a.variadic ? '...' : ''}]` : `<${a.name}${a.variadic ? '...' : ''}>`))
    .join(' ');
}
