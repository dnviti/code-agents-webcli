/**
 * The MCP server that lets a model ask the browser a multiple-choice question.
 *
 * Spawned by the runtime, not by us — same shape as the approval hook, and for
 * the same reason: the CLI owns the child process, and the only way back to the
 * chat session that owns the conversation is the unix socket named in the
 * environment.
 *
 * Why an MCP tool at all, rather than recognising a question the model is
 * already able to ask: it cannot. Probed against Claude Code 2.1.220 (trace kept
 * at `.work/probes/ask/`), the built-in `AskUserQuestion` tool is simply absent
 * from a headless `-p --output-format stream-json` session — it is not in the
 * `system/init` tool list, a tool search does not find it, and the model gives
 * up and asks in prose. The capability has to be supplied, and MCP is how a
 * runtime accepts one. The companion trace at `.work/probes/askmcp/` is the same
 * conversation with this tool present: the model calls it, blocks on the reply,
 * and continues from the answer.
 *
 * Blocking is the entire point. `tools/call` does not respond until a person has
 * clicked something, which is what makes the agent genuinely wait rather than
 * guess and apologise afterwards.
 *
 * Unlike the approval hook, this does *not* fail closed. A question that cannot
 * reach anyone is answered with an error result telling the model to ask in
 * prose instead: there is no unsafe direction here — nothing is gated on the
 * answer — and a silent hang would be strictly worse than a degraded turn.
 */

import * as net from 'net';
import { createInterface } from 'readline';
import { ASK_MCP_SERVER, ASK_QUESTION_TOOL } from '../../shared/chat-events.js';

/** What the browser sends back once someone has answered. */
export interface QuestionAnswer {
  /** Labels of the options picked, in the order they were offered. */
  labels: string[];
  /** True when the user declined to answer rather than picking nothing. */
  skipped?: boolean;
  /** Set when the question could not be put to anyone. */
  error?: string;
}

/**
 * The tool as the model sees it.
 *
 * The description is doing real work: a tool the model never reaches for is the
 * same as no tool at all, so it names the situations this is *for* rather than
 * describing the parameters, which the schema already does.
 */
export const ASK_TOOL_DEFINITION = {
  name: ASK_QUESTION_TOOL,
  description:
    'Ask the user a question with a fixed set of answer options, and wait for their choice. ' +
    'Use this instead of guessing whenever the next step depends on a decision only the user can ' +
    'make and the plausible answers are known up front — which of several approaches to take, ' +
    'which of several candidate files or issues to act on, or any yes/no that would change what ' +
    'you do next. Prefer it over asking in prose: the user answers by clicking, so there is no ' +
    'wording to guess at. This call blocks until they answer.',
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question, written to be answered by picking from the options below.',
      },
      header: {
        type: 'string',
        description: 'A 2-4 word label for the question, used as the card heading.',
      },
      multiSelect: {
        type: 'boolean',
        description:
          'True if the user may pick more than one option before confirming. Defaults to false, ' +
          'meaning exactly one.',
      },
      options: {
        type: 'array',
        minItems: 2,
        description: 'The answers on offer. Keep this to a short, fixed list the user can scan.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The option, in a few words.' },
            description: {
              type: 'string',
              description: 'One line on what picking this would mean. Optional but usually worth it.',
            },
          },
          required: ['label'],
        },
      },
    },
    required: ['question', 'options'],
  },
} as const;

/**
 * The client half of the session socket.
 *
 * One connection, reopened if it drops. A question is matched to its reply by
 * id because the socket is per-session rather than per-call, and a model that
 * asks two things in one turn would otherwise read the wrong answer.
 */
class AskChannel {
  private socket: net.Socket | null = null;
  private nextId = 0;
  private readonly waiting = new Map<string, (answer: QuestionAnswer) => void>();

  constructor(private readonly socketPath: string) {}

  ask(question: unknown): Promise<QuestionAnswer> {
    return new Promise((resolve) => {
      const id = `ask-${process.pid}-${(this.nextId += 1)}`;
      let socket: net.Socket;
      try {
        socket = this.connect();
      } catch (error: unknown) {
        resolve({ labels: [], error: describe(error) });
        return;
      }

      this.waiting.set(id, resolve);
      const write = (): void => {
        socket.write(`${JSON.stringify({ id, kind: 'question', question })}\n`);
      };
      if (socket.pending) {
        socket.once('connect', write);
      } else {
        write();
      }
    });
  }

  private connect(): net.Socket {
    if (this.socket && !this.socket.destroyed) return this.socket;

    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding('utf8');

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let reply: { id?: string; labels?: unknown; skipped?: boolean; error?: string };
        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }
        // Approval traffic shares this socket; anything not addressed to a
        // question we asked belongs to the hook and is not ours to consume.
        const pending = reply.id ? this.waiting.get(reply.id) : undefined;
        if (!pending || !reply.id) continue;
        this.waiting.delete(reply.id);
        pending({
          labels: Array.isArray(reply.labels) ? reply.labels.map(String) : [],
          skipped: reply.skipped === true,
          error: reply.error,
        });
      }
    });

    const fail = (reason: string): void => {
      this.socket = null;
      // Everything still in flight is unanswerable now; say so once rather than
      // leaving the model blocked on a socket that is not coming back.
      for (const [id, resolve] of this.waiting) {
        this.waiting.delete(id);
        resolve({ labels: [], error: reason });
      }
    };
    socket.on('error', () => fail('the browser could not be reached to ask this question'));
    socket.on('close', () => fail('the chat session ended before this question was answered'));

    return socket;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Render an answer as the sentence the model reads back as its tool result. */
export function describeAnswer(answer: QuestionAnswer): { text: string; isError: boolean } {
  if (answer.error) {
    return {
      text:
        `The question could not be put to the user: ${answer.error}. ` +
        'Ask in your reply instead, in plain text, and carry on once they answer.',
      isError: true,
    };
  }
  if (answer.skipped || answer.labels.length === 0) {
    return {
      text:
        'The user skipped this question without choosing. Do not ask it again — ' +
        'either proceed with the most reasonable option and say which you took, or ask them ' +
        'in plain text if you genuinely cannot continue.',
      isError: false,
    };
  }
  return {
    text: `The user selected: ${answer.labels.map((label) => `"${label}"`).join(', ')}`,
    isError: false,
  };
}

interface Rpc {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * Serve MCP on the given streams until stdin closes.
 *
 * Exported and stream-injected so the tests can drive the real protocol over a
 * pair of pipes rather than asserting against a hand-rolled imitation of it.
 */
export function serveAsk(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  ask: (question: unknown) => Promise<QuestionAnswer>,
): void {
  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  createInterface({ input }).on('line', (line: string) => {
    if (!line.trim()) return;
    let message: Rpc;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const { id, method, params } = message;

    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          // Echoed rather than pinned: the negotiated version is whatever the
          // client asked for, and hard-coding one means breaking on the next
          // revision of a spec this server has no opinions about.
          protocolVersion: (params?.protocolVersion as string) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ccweb', version: '1.0.0' },
        },
      });
      return;
    }

    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: [ASK_TOOL_DEFINITION] } });
      return;
    }

    if (method === 'tools/call') {
      if (params?.name !== ASK_QUESTION_TOOL) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no tool named ${String(params?.name)}` } });
        return;
      }
      void ask(params?.arguments).then((answer) => {
        const { text, isError } = describeAnswer(answer);
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });
      });
      return;
    }

    // Notifications carry no id and want no reply; anything else gets an empty
    // result rather than an error, so an unknown-but-harmless method from a
    // future client does not fail the handshake.
    if (id === undefined) return;
    send({ jsonrpc: '2.0', id, result: {} });
  });
}

/** The env var naming the session socket, shared with the approval hook. */
export const ASK_SOCKET_ENV = 'CCWEB_ASK_SOCKET';

/**
 * The `--mcp-config` payload that hands this server to a runtime.
 *
 * Inline JSON rather than a file: nothing is written to the user's own MCP
 * configuration, for exactly the reason the approval hook is passed inline too —
 * this app is not the only thing using that CLI, and a session-scoped capability
 * should not outlive the session or appear in anyone else's tool list.
 */
export function askMcpConfig(serverScript: string, socketPath: string): string {
  return JSON.stringify({
    mcpServers: {
      [ASK_MCP_SERVER]: {
        command: process.execPath,
        args: [serverScript],
        env: { [ASK_SOCKET_ENV]: socketPath },
      },
    },
  });
}

function main(): void {
  const socketPath = process.env[ASK_SOCKET_ENV];
  const channel = socketPath ? new AskChannel(socketPath) : null;
  serveAsk(process.stdin, process.stdout, (question) =>
    channel
      ? channel.ask(question)
      : Promise.resolve({ labels: [], error: 'this session has no channel to the browser' }),
  );
}

// Only when run as the spawned server, so importing this for its tool
// definition (or its tests) does not start reading stdin.
if (process.argv[1] && /ask-mcp\.(js|ts)$/.test(process.argv[1])) {
  main();
}
