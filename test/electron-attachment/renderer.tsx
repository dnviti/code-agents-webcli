import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { uploadAttachment } from '../../src/client/chat/attachments-api';
import { Composer } from '../../src/client/shell/chat/Composer';
import type { ChatAttachment } from '../../src/shared/chat-events';

interface AttachmentProbe {
  ready: boolean;
  socketReady: boolean;
  uploadFiles: Array<{ name: string; mime: string; size: number; bytes: number[] }>;
  uploadResults: ChatAttachment[];
  downloads: Array<{ url: string; status: number; bytes: number[] }>;
  sent: Array<{ text: string; attachments: ChatAttachment[] }>;
  errors: string[];
}

declare global {
  interface Window {
    __attachmentProbe: AttachmentProbe;
  }
}

const parameters = new URLSearchParams(location.search);
const sessionId = parameters.get('sessionId') || '';
const caseName = parameters.get('case') || 'attachment';

window.__attachmentProbe = {
  ready: false,
  socketReady: false,
  uploadFiles: [],
  uploadResults: [],
  downloads: [],
  sent: [],
  errors: [],
};

window.addEventListener('error', (event) => {
  window.__attachmentProbe.errors.push(event.error?.stack || event.message || 'renderer error');
});
window.addEventListener('unhandledrejection', (event) => {
  window.__attachmentProbe.errors.push(
    event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason),
  );
});

function AttachmentHarness(): React.JSX.Element {
  const [draft, setDraft] = React.useState(`Inspect ${caseName}`);
  const [attachments, setAttachments] = React.useState<ChatAttachment[]>([]);
  const socket = React.useRef<WebSocket | null>(null);
  const downloads = React.useRef(new Set<string>());

  React.useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const next = new WebSocket(
      `${protocol}//${location.host}/?sessionId=${encodeURIComponent(sessionId)}`,
    );
    socket.current = next;
    next.addEventListener('open', () => {
      window.__attachmentProbe.socketReady = true;
    });
    next.addEventListener('error', () => {
      window.__attachmentProbe.errors.push('renderer WebSocket failed');
    });
    return () => next.close();
  }, []);

  React.useEffect(() => {
    window.__attachmentProbe.ready = true;
  }, []);

  React.useEffect(() => {
    for (const attachment of attachments) {
      if (downloads.current.has(attachment.url)) continue;
      downloads.current.add(attachment.url);
      void fetch(attachment.url, { credentials: 'same-origin' }).then(async (response) => {
        window.__attachmentProbe.downloads.push({
          url: attachment.url,
          status: response.status,
          bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
        });
      }, (error: unknown) => {
        window.__attachmentProbe.errors.push(
          error instanceof Error ? error.message : 'attachment download failed',
        );
      });
    }
  }, [attachments]);

  async function upload(file: File, signal?: AbortSignal): Promise<ChatAttachment> {
    window.__attachmentProbe.uploadFiles.push({
      name: file.name,
      mime: file.type,
      size: file.size,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
    });
    const attachment = await uploadAttachment(sessionId, file, signal);
    window.__attachmentProbe.uploadResults.push(attachment);
    return attachment;
  }

  function send(text: string, files: ChatAttachment[]): void {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) {
      window.__attachmentProbe.errors.push('send attempted before the renderer WebSocket opened');
      return;
    }
    const message = { type: 'chat_send', sessionId, text, attachments: files };
    socket.current.send(JSON.stringify(message));
    window.__attachmentProbe.sent.push({ text, attachments: files });
  }

  return (
    <main style={{ width: 720, margin: 24 }}>
      <Composer
        onSend={send}
        onInterrupt={() => {}}
        busy={false}
        capabilities={{ attachments: true } as any}
        onUpload={upload}
        draft={draft}
        onDraftChange={setDraft}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<AttachmentHarness />);
