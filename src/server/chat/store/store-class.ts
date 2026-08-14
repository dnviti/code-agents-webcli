import { ChatStoreSession } from './store-session.js';
import type { ChatStoreLike } from './store-types.js';

/**
 * The public chat store class, composed from the split implementation chain.
 */
export class ChatStore extends ChatStoreSession implements ChatStoreLike {}

export default ChatStore;
