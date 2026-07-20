import { createInterface, Interface } from 'node:readline';

/**
 * Interactive prompt helpers for the setup wizard.
 *
 * Deliberately built on the callback `node:readline`, NOT `node:readline/promises`:
 * masking a secret requires overriding the interface's private `_writeToOutput`,
 * and that internal only exists on the callback interface. On a promises
 * interface the override is silently never called and the secret echoes in
 * plaintext.
 */
export class PromptSession {
  private readonly rl: Interface;
  private readonly out: NodeJS.WritableStream;
  private muted = false;

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    this.out = output;
    this.rl = createInterface({ input, output });

    const self = this;
    const target = this.rl as unknown as {
      _writeToOutput?: (chunk: string) => void;
    };
    const originalWrite = target._writeToOutput;

    target._writeToOutput = function writeMasked(this: unknown, chunk: string) {
      if (!self.muted) {
        originalWrite?.call(this, chunk);
        return;
      }
      // Keep newlines so Enter still moves the cursor, drop everything else.
      if (chunk.includes('\n')) {
        originalWrite?.call(this, '\n');
      }
    };
  }

  private ask(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }

  /** Free-text answer. Loops until non-empty when `required`. */
  async value(label: string, defaultValue = '', required = false): Promise<string> {
    for (;;) {
      const prompt = defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
      const response = (await this.ask(prompt)).trim();
      const value = response || defaultValue;
      if (!required || value) {
        return value;
      }
    }
  }

  /** Answer that is never echoed to the terminal. */
  async secret(label: string, defaultValue = '', allowEmpty = false): Promise<string> {
    for (;;) {
      const prompt = defaultValue ? `${label} [saved]: ` : `${label}: `;
      let value: string;
      try {
        // question() writes the prompt synchronously, so mute only afterwards:
        // muting first would hide the label as well as the keystrokes.
        const pending = this.ask(prompt);
        this.muted = true;
        value = (await pending).trim();
      } finally {
        this.muted = false;
        // readline swallowed the echoed newline while muted.
        this.out.write('\n');
      }

      if (value) return value;
      if (defaultValue) return defaultValue;
      if (allowEmpty) return '';
    }
  }

  /** Yes/no question. */
  async confirm(label: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    for (;;) {
      const answer = (await this.ask(`${label} [${hint}]: `)).trim().toLowerCase();
      if (!answer) return defaultValue;
      if (['y', 'yes'].includes(answer)) return true;
      if (['n', 'no'].includes(answer)) return false;
      this.note("Please answer 'y' or 'n'.");
    }
  }

  /** Pick one of a fixed set of options. */
  async select<T extends string>(
    label: string,
    options: ReadonlyArray<{ key: T; label: string }>,
    defaultKey: T,
  ): Promise<T> {
    this.note(`\n${label}`);
    for (const option of options) {
      const marker = option.key === defaultKey ? '*' : ' ';
      this.note(`  ${marker} ${option.key}) ${option.label}`);
    }

    for (;;) {
      const answer = (await this.ask(`Choice [${defaultKey}]: `)).trim().toLowerCase();
      if (!answer) return defaultKey;
      const match = options.find((option) => option.key.toLowerCase() === answer);
      if (match) return match.key;
      this.note(`Please choose one of: ${options.map((o) => o.key).join(', ')}`);
    }
  }

  note(message: string): void {
    this.out.write(`${message}\n`);
  }

  close(): void {
    this.rl.close();
  }
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
