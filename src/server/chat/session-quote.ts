import { PermissionAsk } from './permission-broker.js';

export function quoteTurn(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'an attachment';
  return flat.length > 60 ? `“${flat.slice(0, 57)}…”` : `“${flat}”`;
}

/** One line describing what is being approved, for the card's heading. */
export function describeAsk(ask: PermissionAsk): string {
  const input = ask.toolInput as Record<string, unknown> | undefined;
  const command = typeof input?.command === 'string' ? input.command : null;
  if (command) {
    return command.length > 120 ? `${command.slice(0, 117)}...` : command;
  }
  const filePath = typeof input?.file_path === 'string' ? input.file_path : null;
  if (filePath) return `${ask.toolName} ${filePath}`;
  return ask.toolName;
}
