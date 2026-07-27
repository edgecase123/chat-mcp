import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  kind: 'command' | 'peer' | 'room' | 'path';
}

/**
 * File / directory completion for a `@`-prefixed token. Mirrors the
 * Claude Code / Cursor UX: `@` anywhere in the input triggers filesystem
 * autocomplete rooted at cwd (or the OS root if the token is absolute).
 * Directories get a trailing `/` in the inserted value so the user can
 * keep drilling down.
 */
function pathCompletions(atToken: string): Completion[] {
  const raw = atToken.slice(1); // strip leading '@'
  // Expand '~' at the front to $HOME so `@~/…` works.
  const expanded = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2))
    : raw === '~' ? os.homedir()
    : raw;
  const lastSlash = expanded.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? expanded.slice(0, lastSlash + 1) : '';
  const prefix = lastSlash >= 0 ? expanded.slice(lastSlash + 1) : expanded;
  const dirAbs = path.isAbsolute(dirPart) ? (dirPart || '/') : path.resolve(process.cwd(), dirPart || '.');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const lowerPrefix = prefix.toLowerCase();
  return entries
    .filter((e) => e.name.toLowerCase().startsWith(lowerPrefix))
    // Hide dotfiles unless the user typed a leading dot.
    .filter((e) => !e.name.startsWith('.') || prefix.startsWith('.'))
    // Directories before files, then alpha.
    .sort((a, b) => {
      const aDir = a.isDirectory();
      const bDir = b.isDirectory();
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 30)
    .map((e) => {
      const suffix = e.isDirectory() ? '/' : '';
      // Preserve whatever prefix shape the user typed (relative vs absolute
      // vs '~/...') by rebuilding from the ORIGINAL raw token's dir part,
      // not the expanded one.
      const rawLastSlash = raw.lastIndexOf('/');
      const rawDirPart = rawLastSlash >= 0 ? raw.slice(0, rawLastSlash + 1) : '';
      return {
        value: `@${rawDirPart}${e.name}${suffix}`,
        description: e.isDirectory() ? 'dir' : 'file',
        kind: 'path' as const,
      };
    });
}

/**
 * Compute completions for the current input + cursor position.
 * - If the current token starts with `@`, returns filesystem paths.
 * - Otherwise, input must begin with `/` — command / arg autocomplete.
 * - When cursor is on the command token, matches command names by prefix.
 * - When cursor is inside an argument, matches per the command's arg kind.
 */
export function getCompletions(input: string, cursor: number, ctx: CompletionCtx): Completion[] {
  const beforeCursor = input.slice(0, cursor);
  const tokens = beforeCursor.split(/\s+/);
  const currentToken = tokens[tokens.length - 1] ?? '';

  // `@` path completion — works anywhere in the input, not just after `/`.
  if (currentToken.startsWith('@')) {
    return pathCompletions(currentToken);
  }

  if (!input.startsWith('/')) return [];

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
  const argToken = currentToken;
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
