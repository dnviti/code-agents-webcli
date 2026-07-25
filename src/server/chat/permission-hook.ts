/**
 * The PreToolUse hook the CLI runs before every tool call.
 *
 * Spawned by the agent, not by us: it reads the hook payload on stdin, asks the
 * chat session that owns this conversation (over the unix socket named in the
 * environment), blocks until a person answers in the browser, and prints the
 * decision the CLI expects. Its whole job is to turn a synchronous hook into an
 * asynchronous question.
 *
 * Verified shape of the payload the CLI provides:
 *   session_id, transcript_path, cwd, prompt_id, permission_mode, effort,
 *   hook_event_name, tool_name, tool_input, tool_use_id
 *
 * Fails closed. Every path that cannot reach a human — no socket, no server,
 * malformed input, a broken connection mid-question — denies. An approval that
 * could not be asked for has not been granted, and the cost of being wrong in
 * that direction is a refused tool call the user can retry.
 */

import * as net from 'net';

interface HookPayload {
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  cwd?: string;
}

function emit(allow: boolean, reason: string): void {
  // `ask` is deliberately never returned: there is no terminal attached to
  // prompt on, so an "ask" would hang the agent against a UI that does not
  // exist. Every decision here is already final.
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: allow ? 'allow' : 'deny',
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main(): Promise<void> {
  const socketPath = process.env.CCWEB_PERMISSION_SOCKET;
  if (!socketPath) {
    emit(false, 'the browser approval channel is not configured for this session');
    return;
  }

  const raw = await readStdin();
  let payload: HookPayload;
  try {
    payload = JSON.parse(raw) as HookPayload;
  } catch {
    emit(false, 'the approval hook could not read the tool call');
    return;
  }

  const id = `${process.pid}-${Date.now()}`;
  const socket = net.createConnection(socketPath);
  let settled = false;

  const finish = (allow: boolean, reason: string): void => {
    if (settled) return;
    settled = true;
    try {
      socket.destroy();
    } catch {
      // Already closed.
    }
    emit(allow, reason);
  };

  socket.on('error', () => {
    finish(false, 'the browser approval channel is unavailable');
  });

  socket.on('close', () => {
    // Reaching here unsettled means the session went away mid-question.
    finish(false, 'the session ended before this tool call was approved');
  });

  socket.on('connect', () => {
    socket.write(
      `${JSON.stringify({
        id,
        ask: {
          toolName: payload.tool_name || 'unknown',
          toolInput: payload.tool_input,
          toolUseId: payload.tool_use_id,
          cwd: payload.cwd,
        },
      })}\n`,
    );
  });

  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let at: number;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;

      let answer: { id?: string; allow?: boolean; reason?: string };
      try {
        answer = JSON.parse(line);
      } catch {
        continue;
      }
      // Ignore an answer meant for a different in-flight question; the socket
      // is per-session, not per-call, so more than one can be open.
      if (answer.id !== id) continue;

      finish(
        answer.allow === true,
        answer.reason || (answer.allow ? 'approved in the browser' : 'denied in the browser'),
      );
      return;
    }
  });
}

main().catch(() => {
  emit(false, 'the approval hook failed');
});
