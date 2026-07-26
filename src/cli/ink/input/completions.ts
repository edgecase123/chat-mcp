import { COMMANDS, findCommand } from '../commands.js';

export interface CompletionCtx {
  me: string;
  peers: string[];
  memberRooms: string[];
  discoverRooms: string[];
}

export interface Completion {
  value: string;        // text to insert (command name or arg value)
  display?: string;     // optional label; falls back to value
  description?: string; // shown dim after the value
  kind: 'command' | 'peer' | 'room';
}

/**
 * Compute completions for the current input + cursor position.
 * - Input must begin with `/`; else returns [].
 * - When cursor is on the command token, matches command names by prefix.
 * - When cursor is inside an argument, matches per the command's arg kind.
 */
export function getCompletions(input: string, cursor: number, ctx: CompletionCtx): Completion[] {
  if (!input.startsWith('/')) return [];
  const beforeCursor = input.slice(0, cursor);
  const tokens = beforeCursor.split(/\s+/);
  // Command token itself (index 0)
  if (tokens.length === 1) {
    const prefix = tokens[0]!.toLowerCase();
    return COMMANDS.filter((c) => c.name.toLowerCase().startsWith(prefix)).map((c) => ({
      value: c.name,
      description: c.description,
      kind: 'command',
    }));
  }

  const cmd = findCommand(tokens[0]!);
  if (!cmd) return [];

  const argIndex = tokens.length - 2; // -1 for command token itself; then convert to arg index
  const argToken = tokens[tokens.length - 1] ?? '';
  const arg = cmd.args[argIndex];
  if (!arg) return [];

  const lower = argToken.toLowerCase();

  switch (arg.kind) {
    case 'peer':
      return ctx.peers
        .filter((p) => p !== ctx.me && p.toLowerCase().startsWith(lower))
        .map((p) => ({ value: p, kind: 'peer' }));
    case 'room': {
      const source = cmd.name === '/join' ? ctx.discoverRooms : ctx.memberRooms;
      return source
        .filter((r) => r.toLowerCase().startsWith(lower))
        .map((r) => ({ value: r, kind: 'room' }));
    }
    case 'target': {
      // /alert accepts either a peer or a joined room. Disambiguate by
      // the current token's leading '#'.
      if (argToken.startsWith('#')) {
        return ctx.memberRooms
          .filter((r) => r.toLowerCase().startsWith(lower))
          .map((r) => ({ value: r, kind: 'room' }));
      }
      return ctx.peers
        .filter((p) => p !== ctx.me && p.toLowerCase().startsWith(lower))
        .map((p) => ({ value: p, kind: 'peer' }));
    }
    case 'status':
    case 'text':
    case 'none':
      return [];
  }
}
