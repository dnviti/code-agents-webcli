import { ChatBlock, ChatMessage, withoutQuestionFallbackEnvelope } from '../chat-events.js';

/** Plain text of a message, for search indexing and export. */
export function messageText(message: ChatMessage): string {
  const parts: string[] = [];
  for (const block of message.blocks) {
    const text = blockText(block);
    parts.push(message.role === 'assistant' && block.kind === 'text'
      ? withoutQuestionFallbackEnvelope(text)
      : text);
  }
  return parts.filter(Boolean).join('\n');
}

function blockText(block: ChatBlock): string {
  switch (block.kind) {
    case 'text':
    case 'thinking':
      return block.text;
    case 'error':
      return block.text;
    case 'tool':
      return [block.title || block.name, block.output].filter(Boolean).join('\n');
    case 'plan':
      return block.items.map((item) => `- [${item.status}] ${item.text}`).join('\n');
    case 'image':
      return block.alt || '';
    case 'attachment':
      return `${block.name} (${block.url})`;
    case 'question':
      return [
        block.request.question,
        ...block.request.options.map((option) => option.label),
        ...((block.answer?.optionIds ?? []).map((optionId) =>
          block.request.options.find((option) => option.optionId === optionId)?.label ?? optionId)),
        block.answer?.text ?? '',
      ].join('\n');
    default:
      return '';
  }
}
