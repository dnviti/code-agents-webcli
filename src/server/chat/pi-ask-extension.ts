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
import {
  ASK_QUESTION_TOOL,
  SUBMIT_PLAN_TOOL,
  SUBMIT_PLAN_TOOL_DESCRIPTION,
} from '../../shared/chat-events.js';
import { MANAGED_MARKER } from '../services/tier-writer.js';
import { FILE_CALLBACK_GENERATED_CLIENT_SOURCE } from './file-callback.js';

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
import * as crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const SOCKET = process.env.CCWEB_ASK_SOCKET;
const CALLBACK_DIR = process.env.CCWEB_CALLBACK_DIR;
const CALLBACK_TOKEN = process.env.CCWEB_CALLBACK_TOKEN;
const CALLBACK_LIVENESS_MS = Number(process.env.CCWEB_CALLBACK_LIVENESS_MS) || 10000;

${FILE_CALLBACK_GENERATED_CLIENT_SOURCE}

function askSocket(question: string, header: string | undefined, options: any[], multiSelect: boolean) {
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

function submitPlanSocket(markdown: string) {
  return new Promise<string>((resolve) => {
    const socket = net.createConnection(SOCKET as string);
    const id = "plan-" + process.pid + "-" + Date.now();
    let buffer = "";
    const done = (text: string) => {
      socket.destroy();
      resolve(text);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(JSON.stringify({ id, kind: "plan", plan: { markdown } }) + "\\n");
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
          done(typeof reply.detail === "string" ? reply.detail :
            (reply.accepted ? "Plan saved." : "The Plan document was refused."));
          return;
        } catch {
          // Not ours, or not JSON.
        }
      }
    });
    socket.on("error", () => done(
      "The plan could not reach the Web interface. Return it as your final markdown reply instead.",
    ));
    socket.on("close", () => done(
      "The conversation ended before the plan could be stored. Return it as markdown instead.",
    ));
  });
}

async function fileRequest(kind: string, payload: any): Promise<any> {
  if (!CALLBACK_DIR || !CALLBACK_TOKEN) throw new Error("no callback channel");
  const layout = await callbackLayout(CALLBACK_DIR);
  const id = crypto.randomBytes(16).toString("base64url");
  const requestFile = path.join(layout.requests.path, id + ".json");
  const replyFile = path.join(layout.replies.path, id + ".json");
  const heartbeatFile = path.join(layout.replies.path, "heartbeat.json");
  const initialHeartbeat: any = await callbackRead(
    layout.replies, heartbeatFile, CALLBACK_TOKEN, CALLBACK_AAD_PREFIX + "heartbeat",
  );
  let lastHeartbeat = typeof initialHeartbeat?.ts === "number" ? initialHeartbeat.ts : null;
  let lastHeartbeatChange = Date.now();
  await callbackAtomic(
    layout.requests,
    requestFile,
    CALLBACK_TOKEN,
    callbackAad("request", id),
    { id, kind, payload, createdAt: Date.now() },
  );
  const deadline = Date.now() + 2147000000;
  let nextLivenessCheck = Date.now() + CALLBACK_LIVENESS_MS;
  try {
    while (Date.now() < deadline) {
      const reply: any = await callbackRead(
        layout.replies, replyFile, CALLBACK_TOKEN, callbackAad("reply", id),
      );
      if (reply) {
        if (reply.id !== id) throw new Error("invalid callback reply");
        if (reply.error) throw new Error(reply.error);
        if (reply.cancelled) throw new Error("the agent stopped waiting");
        return reply.result;
      }
      if (Date.now() >= nextLivenessCheck) {
        const heartbeat: any = await callbackRead(
          layout.replies, heartbeatFile, CALLBACK_TOKEN, CALLBACK_AAD_PREFIX + "heartbeat",
        );
        if (!heartbeat || typeof heartbeat.ts !== "number") {
          throw new Error("the callback server is unavailable");
        }
        if (heartbeat.ts !== lastHeartbeat) {
          lastHeartbeat = heartbeat.ts;
          lastHeartbeatChange = Date.now();
        } else if (Date.now() - lastHeartbeatChange >= CALLBACK_LIVENESS_MS) {
          throw new Error("the callback server is unavailable");
        }
        nextLivenessCheck = Date.now() + Math.min(2000, CALLBACK_LIVENESS_MS);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("the browser did not answer before the callback timed out");
  } finally {
    await callbackUnlink(layout.requests, requestFile).catch(() => {});
    await callbackUnlink(layout.replies, replyFile).catch(() => {});
  }
}

function describeQuestionReply(reply: any): string {
  if (reply?.error) return "The question could not be put to the user: " + reply.error +
    ". Ask in your reply instead, in plain prose.";
  const labels = Array.isArray(reply?.labels) ? reply.labels : [];
  const typed = typeof reply?.text === "string" && reply.text ? reply.text : "";
  if (reply?.skipped || (labels.length === 0 && !typed)) return
    "The user skipped this question without choosing. Do not ask it again - carry on with the most reasonable option and say which one you took.";
  if (labels.length && typed) return "The user chose: " + labels.join(", ") + ". They also said: " + typed;
  return typed ? "The user answered in their own words: " + typed : "The user chose: " + labels.join(", ");
}

async function ask(question: string, header: string | undefined, options: any[], multiSelect: boolean) {
  if (SOCKET) return askSocket(question, header, options, multiSelect);
  try {
    return describeQuestionReply(await fileRequest("question", { question, header, options, multiSelect }));
  } catch (error: any) {
    return "The question could not reach the user: " + error.message + ". Ask in prose instead.";
  }
}

async function submitPlan(markdown: string) {
  if (SOCKET) return submitPlanSocket(markdown);
  try {
    const result = await fileRequest("plan", { markdown });
    return result?.detail || (result?.accepted ? "Plan saved." : "The Plan document was refused.");
  } catch (error: any) {
    return "The plan could not reach the Web interface: " + error.message +
      ". Return it as your final markdown reply instead.";
  }
}

export default function (pi: any) {
  if (!SOCKET && !(CALLBACK_DIR && CALLBACK_TOKEN)) return;
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
  pi.registerTool({
    name: "${SUBMIT_PLAN_TOOL}",
    label: "Submit plan",
    description: ${JSON.stringify(SUBMIT_PLAN_TOOL_DESCRIPTION)},
    parameters: Type.Object({
      markdown: Type.String({
        description: "The complete latest plan as markdown, not a patch against an earlier revision.",
      }),
    }),
    async execute(_toolCallId: string, params: { markdown: string }) {
      const text = await submitPlan(params.markdown);
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
`;

interface OpenGeneratedDirectory {
  fd: number;
  accessPath: string;
  visiblePath: string;
  dev: number;
  ino: number;
}

function generatedFdAccessPath(fd: number): string {
  return process.platform === 'linux' ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`;
}

function sameGeneratedDirectory(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function openGeneratedDirectory(target: string, visiblePath = target): OpenGeneratedDirectory {
  const fd = fs.openSync(
    target,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    const accessPath = generatedFdAccessPath(fd);
    const anchored = fs.statSync(accessPath);
    if (!stat.isDirectory() || !anchored.isDirectory() || !sameGeneratedDirectory(stat, anchored)) {
      throw new Error('generated pi callback fd access is unavailable');
    }
    return { fd, accessPath, visiblePath, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function openGeneratedChildDirectory(
  parent: OpenGeneratedDirectory,
  name: string,
): OpenGeneratedDirectory {
  const target = path.join(parent.accessPath, name);
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return openGeneratedDirectory(target, path.join(parent.visiblePath, name));
}

function verifyGeneratedDirectory(directory: OpenGeneratedDirectory): void {
  const visible = openGeneratedDirectory(directory.visiblePath);
  try {
    if (!sameGeneratedDirectory(visible, directory)) {
      throw new Error('pi callback artifact directory changed during the operation');
    }
  } finally {
    fs.closeSync(visible.fd);
  }
}

function openPiGeneratedDirectory(workingDir: string): OpenGeneratedDirectory {
  const working = openGeneratedDirectory(path.resolve(workingDir));
  let pi: OpenGeneratedDirectory | null = null;
  try {
    pi = openGeneratedChildDirectory(working, '.pi');
    return openGeneratedChildDirectory(pi, 'ccweb');
  } finally {
    if (pi) fs.closeSync(pi.fd);
    fs.closeSync(working.fd);
  }
}

function ensureGeneratedIgnore(directory: OpenGeneratedDirectory, contents: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(
      path.join(directory.accessPath, '.gitignore'),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, contents, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function writeGeneratedArtifact(directory: OpenGeneratedDirectory, name: string, contents: string): void {
  let artifactFd: number | null = null;
  try {
    try {
      artifactFd = fs.openSync(
        path.join(directory.accessPath, name),
        fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      artifactFd = fs.openSync(
        path.join(directory.accessPath, name),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
    }
    const artifactStat = fs.fstatSync(artifactFd);
    if (!artifactStat.isFile() || artifactStat.nlink !== 1) {
      throw new Error('unsafe generated pi callback artifact');
    }
    verifyGeneratedDirectory(directory);
    fs.ftruncateSync(artifactFd, 0);
    fs.writeFileSync(artifactFd, contents, { encoding: 'utf8' });
    fs.fchmodSync(artifactFd, 0o600);
    fs.fsyncSync(artifactFd);
    verifyGeneratedDirectory(directory);
  } finally {
    if (artifactFd !== null) fs.closeSync(artifactFd);
  }
}

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
  let directory: OpenGeneratedDirectory | null = null;
  try {
    directory = openPiGeneratedDirectory(workingDir);
    ensureGeneratedIgnore(directory, [
      '# Written by code-agents-webcli: generated tools for this session.',
      '# Regenerated on every launch; nothing here is yours to keep.',
      '*',
      '',
    ].join('\n'));
    writeGeneratedArtifact(directory, 'ask-user.ts', PI_ASK_EXTENSION);
    return PI_ASK_EXTENSION_PATH;
  } catch (error) {
    console.warn('Could not write the question extension for pi:', error);
    return null;
  } finally {
    if (directory) fs.closeSync(directory.fd);
  }
}
