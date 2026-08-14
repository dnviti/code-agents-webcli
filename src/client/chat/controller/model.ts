import { ChatControllerDraft } from './draft.js';
import { ChatModelDefault, ChatModelOrigin } from '../../../shared/chat-events.js';
import { EffortSwitchResult, ModelSwitchResult } from './types.js';

/**
 * Model and effort overrides, and the server verdicts on them.
 */
export abstract class ChatControllerModel extends ChatControllerDraft {
  /** The model override in force for this conversation, or null if there is none. */
  get modelOverrideValue(): string | null {
    return this.modelOverride;
  }

  /**
   * Where a new conversation on this runtime would get its model, or null when
   * the server did not say.
   */
  get modelDefaultValue(): ChatModelDefault | null {
    return this.modelDefault;
  }

  /**
   * The model this conversation is fixed to, or null when nothing says.
   */
  get modelPinnedValue(): string | null {
    return this.modelPinned;
  }

  /**
   * Where the model in force came from — the ladder, the profile, the account's
   * standing choice, or the runtime's own default.
   *
   * Beside `modelDefaultValue` rather than replacing it: one says what this
   * conversation is on, the other what the next one would open on, and using
   * either for the other is how the chip came to name a standing choice that
   * had never been applied to the conversation showing it (#135).
   */
  get modelOriginValue(): ChatModelOrigin | null {
    return this.modelOrigin;
  }

  /** Why this conversation's ladder was not applied, when it was not. */
  get ladderErrorValue(): string | null {
    return this.ladderError;
  }

  /** What happened the last time this browser asked to change the model. */
  get modelFeedback(): ModelSwitchResult | null {
    return this.modelResult;
  }

  /**
   * Ask the server to switch this conversation's model, or clear the override
   * with an empty string.
   *
   * Never validated here: the composer sends whatever was typed, and the
   * server's reply — live, sent, or saved-for-next-time — is what actually
   * tells the user what happened.
   */
  setModel(model: string): void {
    this.send({ type: 'chat_set_model', model });
  }

  /** The effort level chosen for this conversation, or null if none was. */
  get effortOverrideValue(): string | null {
    return this.effortOverride;
  }

  /** What happened the last time this browser asked to change the effort level. */
  get effortFeedback(): EffortSwitchResult | null {
    return this.effortResult;
  }

  /**
   * Ask the server to change how hard this conversation thinks, or clear the
   * choice with an empty string.
   *
   * Unlike the model, the server does check this one against what the runtime
   * published — but the check belongs there and not here, because only the
   * server can see the live session's capabilities, and a browser holding a
   * stale menu is exactly the case the check exists for.
   */
  setEffort(effort: string): void {
    this.send({ type: 'chat_set_effort', effort });
  }
}
