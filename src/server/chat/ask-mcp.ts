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
import { ASK_MCP_SERVER, ASK_QUESTION_TOOL, TIER_TOOL } from '../../shared/chat-events.js';

/**
 * Whether this server should offer the ladder tool at all.
 *
 * Set by the session at spawn, and only for a conversation actually running on
 * a rung. An env var rather than an argument because the runtime composes the
 * argv, not us — the same reason the socket path arrives this way.
 */
export const TIER_ENABLED_ENV = 'CCWEB_TIER_LADDER';

/** What the browser sends back once someone has answered. */
export interface QuestionAnswer {
  /** Labels of the options picked, in the order they were offered. */
  labels: string[];
  /**
   * What the user wrote, when they answered in their own words.
   *
   * The card always offers this alongside the options, so it arrives on its own
   * for "none of these is quite right" and beside `labels` for "these two, and
   * here is the caveat". Either way it is a real answer and not a skip.
   */
  text?: string;
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
    'wording to guess at. This call blocks until they answer. Do not add an "other", "none of ' +
    'these" or "let me explain in my own words" option: the card always offers a free-text box ' +
    'alongside your options, and whatever the user types there comes back as their answer.',
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
        description:
          'The answers on offer. Keep this to a short, fixed list the user can scan. ' +
          'Each may be an object with a label and an optional description, or just the ' +
          'label as a plain string.',
        // A bare string is accepted as well as an object, because omp's model
        // sent `["Tabs", "Spaces"]`, had the call rejected by schema validation
        // before it ever reached this server, and had to burn a second round
        // trip retrying. The shape was always understood here; only the schema
        // objected.
        items: {
          anyOf: [
            { type: 'string', description: 'The option, in a few words.' },
            {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'The option, in a few words.' },
                description: {
                  type: 'string',
                  description:
                    'One line on what picking this would mean. Optional but usually worth it.',
                },
              },
              required: ['label'],
            },
          ],
        },
      },
    },
    required: ['question', 'options'],
  },
} as const;

/** What the session sends back once a rung request has been decided. */
export interface TierDecision {
  granted: boolean;
  tier?: string;
  model?: string;
  detail: string;
}

/**
 * The escalation tool, as the model sees it.
 *
 * The description carries the cost, because that is the whole judgement being
 * asked for: a model that reaches for this on every turn turns a ladder built to
 * control spending into a ladder that only ever runs at the top.
 */
export const TIER_TOOL_DEFINITION = {
  name: TIER_TOOL,
  description:
    'Ask to answer this task from the next model up your capability ladder, and wait for the ' +
    'user to approve. Use it only when the work in front of you is genuinely beyond the model ' +
    'you are on — subtle debugging, ambiguous architecture, security-sensitive logic, review of ' +
    'code that matters — and not for work that is merely long or tedious. The stronger model ' +
    'costs the user real money, they are asked before it is used, and the conversation returns ' +
    'to its usual rung once this turn ends. This call blocks until they decide. If it is ' +
    'refused, carry on with the model you have rather than asking again.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description:
          'One sentence on what makes this task too hard for the model you are on. The user ' +
          'reads this and nothing else before deciding, so name the specific difficulty.',
      },
    },
    required: ['reason'],
  },
} as const;

/**
 * The client half of the session socket.
 *
 * One connection, reopened if it drops. A call is matched to its reply by id
 * because the socket is per-session rather than per-call, and a model that asks
 * two things in one turn would otherwise read the wrong answer.
 */
class AskChannel {
  private socket: net.Socket | null = null;
  private nextId = 0;
  private readonly waiting = new Map<string, (answer: QuestionAnswer) => void>();
  private readonly waitingTier = new Map<string, (decision: TierDecision) => void>();

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

  requestTier(reason: unknown): Promise<TierDecision> {
    return new Promise((resolve) => {
      const id = `tier-${process.pid}-${(this.nextId += 1)}`;
      let socket: net.Socket;
      try {
        socket = this.connect();
      } catch (error: unknown) {
        resolve({ granted: false, detail: describe(error) });
        return;
      }

      this.waitingTier.set(id, resolve);
      const write = (): void => {
        socket.write(`${JSON.stringify({ id, kind: 'tier', tier: { reason } })}\n`);
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
        let reply: {
          id?: string;
          labels?: unknown;
          text?: unknown;
          skipped?: boolean;
          error?: string;
        };
        try {
          reply = JSON.parse(line);
        } catch {
          continue;
        }
        if (!reply.id) continue;

        // Three kinds of traffic share this socket, and each id is minted by
        // whichever map is waiting on it — so an id in neither belongs to the
        // approval hook and is not ours to consume.
        const pendingTier = this.waitingTier.get(reply.id);
        if (pendingTier) {
          this.waitingTier.delete(reply.id);
          const decision = reply as unknown as Partial<TierDecision>;
          pendingTier({
            granted: decision.granted === true,
            tier: typeof decision.tier === 'string' ? decision.tier : undefined,
            model: typeof decision.model === 'string' ? decision.model : undefined,
            detail: typeof decision.detail === 'string' ? decision.detail : 'no answer was given',
          });
          continue;
        }

        const pending = this.waiting.get(reply.id);
        if (!pending) continue;
        this.waiting.delete(reply.id);
        pending({
          labels: Array.isArray(reply.labels) ? reply.labels.map(String) : [],
          text: typeof reply.text === 'string' && reply.text ? reply.text : undefined,
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
      for (const [id, resolve] of this.waitingTier) {
        this.waitingTier.delete(id);
        resolve({ granted: false, detail: reason });
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
  if (answer.skipped || (answer.labels.length === 0 && !answer.text)) {
    return {
      text:
        'The user skipped this question without choosing. Do not ask it again — ' +
        'either proceed with the most reasonable option and say which you took, or ask them ' +
        'in plain text if you genuinely cannot continue.',
      isError: false,
    };
  }
  const selected = `The user selected: ${answer.labels.map((label) => `"${label}"`).join(', ')}`;
  // Their own words are the answer when nothing was picked, and a correction to
  // what was picked when something was. Said explicitly either way: the model
  // has to know this sentence is the user's and not one of the options it
  // wrote, because it is the half of the answer it could not anticipate.
  if (answer.text && answer.labels.length === 0) {
    return {
      text:
        'The user picked none of the options and answered in their own words: ' +
        `"${answer.text}". Treat this as their answer and continue from it.`,
      isError: false,
    };
  }
  if (answer.text) {
    return {
      text: `${selected} — and added, in their own words: "${answer.text}"`,
      isError: false,
    };
  }
  return { text: selected, isError: false };
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
  // Optional so a runtime whose session has no ladder simply never advertises
  // the tool: an escalation the app cannot grant is worse than one the model
  // never knew about, because the refusal costs a round trip and reads to the
  // model as the user saying no.
  requestTier?: (reason: unknown) => Promise<TierDecision>,
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
      const tools = requestTier
        ? [ASK_TOOL_DEFINITION, TIER_TOOL_DEFINITION]
        : [ASK_TOOL_DEFINITION];
      send({ jsonrpc: '2.0', id, result: { tools } });
      return;
    }

    if (method === 'tools/call') {
      if (params?.name === ASK_QUESTION_TOOL) {
        void ask(params?.arguments).then((answer) => {
          const { text, isError } = describeAnswer(answer);
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } });
        });
        return;
      }
      if (params?.name === TIER_TOOL && requestTier) {
        const reason = (params?.arguments as { reason?: unknown } | undefined)?.reason;
        void requestTier(reason).then((decision) => {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: decision.detail }],
              // Never an error result, even refused. A refusal is an answer the
              // model is meant to act on — carry on at the rung you are on —
              // and marking it an error invites a retry of the one call whose
              // whole cost is asking a person again.
              isError: false,
            },
          });
        });
        return;
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no tool named ${String(params?.name)}` } });
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
export function askMcpConfig(
  serverScript: string,
  socketPath: string,
  // Both paths are read by the *runtime*, which may not be running on this
  // machine: in a per-user container the script and socket arrive through bind
  // mounts under different paths, and this host's node binary is not there at
  // all. The caller translates; the default is the host.
  nodePath: string = process.execPath,
  laddered = false,
): string {
  return JSON.stringify({
    mcpServers: {
      [ASK_MCP_SERVER]: {
        command: nodePath,
        args: [serverScript],
        env: {
          [ASK_SOCKET_ENV]: socketPath,
          ...(laddered ? { [TIER_ENABLED_ENV]: '1' } : {}),
        },
      },
    },
  });
}

function main(): void {
  const socketPath = process.env[ASK_SOCKET_ENV];
  const channel = socketPath ? new AskChannel(socketPath) : null;
  const laddered = process.env[TIER_ENABLED_ENV] === '1';
  serveAsk(
    process.stdin,
    process.stdout,
    (question) =>
      channel
        ? channel.ask(question)
        : Promise.resolve({ labels: [], error: 'this session has no channel to the browser' }),
    laddered && channel ? (reason) => channel.requestTier(reason) : undefined,
  );
}

// Only when run as the spawned server, so importing this for its tool
// definition (or its tests) does not start reading stdin.
if (process.argv[1] && /ask-mcp\.(js|ts)$/.test(process.argv[1])) {
  main();
}
