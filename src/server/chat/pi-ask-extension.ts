/**
 * pi's half of the question channel, as a generated pi extension.
 *
 * Every other runtime that can ask a question is handed the MCP server in
 * `ask-mcp.ts` — on the command line for claude, in the ACP handshake for omp
 * and kimi. pi can take neither: its own dist tree has no MCP implementation at
 * all, and it does not speak ACP. What it does take is an extension that
 * registers a tool, which is the same capability by a different road and is
 * already how the capability ladder reaches it (see `tier-writer.ts`).
 *
 * Why bother, when a model can always ask in prose: because on pi it was asking
 * and getting nothing back. The widely installed `pi-code` package registers a
 * tool of its own called `question`, pi offers it on every turn this app starts,
 * and in the non-interactive mode this app drives it answers itself —
 * "Error: UI not available (running in non-interactive mode)" — without anybody
 * being asked. The model reads that as a dead end, and the user sees a grey tool
 * row and an agent that carried on having guessed (#174). A tool that reaches a
 * real card is the fix; `--exclude-tools question` beside it is what stops the
 * model reaching for the dead one first.
 *
 * Written as source rather than assembled from the session's values, for the
 * same reason the ladder extension is: it reads what it needs from the
 * environment at call time, so one static file serves every session, and a
 * session with no socket in its environment registers nothing at all.
 *
 * `node:net` and the newline-framed JSON are the same client the MCP server
 * uses. Deliberately not shared with it: this file is compiled by pi's own
 * TypeScript loader inside pi's process, and importing anything of this app's
 * would drag the app's module graph into the agent.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ASK_QUESTION_TOOL } from '../../shared/chat-events.js';
import { MANAGED_MARKER } from '../services/tier-writer.js';

/** Where the extension is written, relative to the session's working directory. */
export const PI_ASK_EXTENSION_PATH = path.join('.pi', 'ccweb', 'ask-user.ts');

/**
 * The extension source.
 *
 * The tool is named exactly as the MCP one is, so every surface downstream that
 * recognises a question — the card, the trace, the attention mark — recognises
 * pi's too without learning a second name.
 */
export const PI_ASK_EXTENSION = `// ${MANAGED_MARKER}
// Generated. Registers this session's question tool, which draws a card in the
// browser and blocks until somebody answers it.
import { Type } from "typebox";
import * as net from "node:net";

const SOCKET = process.env.CCWEB_ASK_SOCKET;

function ask(question: string, header: string | undefined, options: any[], multiSelect: boolean) {
  return new Promise<string>((resolve) => {
    const socket = net.createConnection(SOCKET as string);
    const id = "ask-" + process.pid + "-" + Date.now();
    let buffer = "";
    const done = (text: string) => {
      socket.destroy();
      resolve(text);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({
          id,
          kind: "question",
          question: { question, header, options, multiSelect },
        }) + "\\n",
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        try {
          const reply = JSON.parse(line);
          if (reply.id !== id) continue;
          if (reply.error) {
            done("The question could not be put to the user: " + reply.error +
              ". Ask in your reply instead, in plain prose.");
            return;
          }
          const labels = Array.isArray(reply.labels) ? reply.labels : [];
          const typed = typeof reply.text === "string" && reply.text ? reply.text : "";
          if (reply.skipped || (labels.length === 0 && !typed)) {
            done("The user skipped this question without choosing. Do not ask it again - " +
              "carry on with the most reasonable option and say which one you took.");
            return;
          }
          if (labels.length && typed) {
            done("The user chose: " + labels.join(", ") + ". They also said: " + typed);
            return;
          }
          done(typed ? "The user answered in their own words: " + typed
            : "The user chose: " + labels.join(", "));
          return;
        } catch {
          // Not ours, or not JSON. The socket is shared.
        }
      }
    });
    socket.on("error", () => done("The question could not reach the user. Ask in prose instead."));
    socket.on("close", () =>
      done("The conversation ended before this question was answered."));
  });
}

export default function (pi: any) {
  if (!SOCKET) return;
  pi.registerTool({
    name: "${ASK_QUESTION_TOOL}",
    label: "Ask the user",
    description:
      "Ask the user a question with a fixed set of answer options, and wait for their choice. " +
      "Use this instead of guessing whenever the next step depends on a decision only the user " +
      "can make and the plausible answers are known up front - which of several approaches to " +
      "take, which of several candidate files or issues to act on, or any yes/no that would " +
      "change what you do next. Prefer it over asking in prose: the user answers by clicking, so " +
      "there is no wording to guess at. This call blocks until they answer. Do not add an " +
      "\\"other\\" or \\"none of these\\" option: the card always offers a free-text box beside " +
      "your options, and whatever the user types there comes back as their answer.",
    parameters: Type.Object({
      question: Type.String({
        description: "The question, as one sentence a person can answer by picking an option.",
      }),
      header: Type.Optional(Type.String({
        description: "Two or three words naming the decision, shown above the question.",
      })),
      multiSelect: Type.Optional(Type.Boolean({
        description: "True when more than one option may be picked at once.",
      })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "The choice, in a few words." }),
          description: Type.Optional(Type.String({
            description: "One line on what picking this would mean.",
          })),
        }),
        { description: "Two to five options, each one a decision the user could take." },
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { question: string; header?: string; multiSelect?: boolean; options: any[] },
    ) {
      const text = await ask(
        params.question,
        params.header,
        Array.isArray(params.options) ? params.options : [],
        params.multiSelect === true,
      );
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
`;

/**
 * Put the extension in the session's working directory, and say where.
 *
 * Beside the ladder's own file and under the same `.pi/ccweb` — not
 * `.pi/extensions`, which pi auto-discovers for a trusted project: discovered
 * *and* passed with `-e` is the same extension loaded twice, registering its
 * tool twice.
 *
 * Returns the relative path to pass to `-e`, or null if it could not be
 * written. Relative deliberately: an absolute host path is not the path this
 * file has inside a per-user container, and the working directory is the one
 * thing both sides agree on.
 *
 * A failure here is not a failure of the session. Losing the question tool
 * costs the model a way to ask; refusing to start the conversation over it
 * would cost the user everything else too.
 */
export function writePiAskExtension(workingDir: string): string | null {
  try {
    const file = path.join(workingDir, PI_ASK_EXTENSION_PATH);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(dir, '.gitignore'),
        [
          '# Written by code-agents-webcli: generated tools for this session.',
          '# Regenerated on every launch; nothing here is yours to keep.',
          '*',
          '',
        ].join('\n'),
        { flag: 'wx' },
      );
    } catch {
      // Already there — the normal case after the first launch, and the case
      // where the ladder's own writer got here first. Either way it says the
      // same thing about the same directory.
    }
    fs.writeFileSync(file, PI_ASK_EXTENSION, 'utf8');
    return PI_ASK_EXTENSION_PATH;
  } catch (error) {
    console.warn('Could not write the question extension for pi:', error);
    return null;
  }
}
