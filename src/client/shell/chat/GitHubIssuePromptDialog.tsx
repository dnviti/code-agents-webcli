import * as React from 'react';
import { Button } from '../../ui/relay/Button.js';
import { Dialog } from '../../ui/relay/Dialog.js';
import { usePhone, PHONE_TEXT } from '../../ui/touch.js';

export interface GitHubIssuePromptDialogProps {
  open: boolean;
  value: string;
  /** Stable while the same draft survives dialog/rail unmounts. */
  requestId: string;
  /** The same live availability gate as the header action. */
  disabledReason?: string | null;
  onValueChange: (value: string) => void;
  onStart: (prompt: string, requestId: string) => Promise<void>;
  onClose: () => void;
}

/**
 * The small handoff into the issue interview. The issue itself is still
 * created by the guided chat workflow: this field deliberately captures only
 * the person's first description, not a second, incomplete issue form.
 */
export function GitHubIssuePromptDialog({
  open,
  value,
  requestId,
  disabledReason,
  onValueChange,
  onStart,
  onClose,
}: GitHubIssuePromptDialogProps): React.JSX.Element | null {
  const isPhone = usePhone();
  const fieldId = React.useId();
  const errorId = React.useId();
  const fieldRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setError(null);
      setSubmitting(false);
      setFocused(false);
      return;
    }
    window.setTimeout(() => fieldRef.current?.focus(), 0);
  }, [open]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    const prompt = value.trim();
    if (!prompt) {
      setError('Describe the issue before starting the guided review.');
      fieldRef.current?.focus();
      return;
    }
    if (disabledReason) {
      setError(disabledReason);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onStart(prompt, requestId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The issue workflow could not be started. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Create GitHub issue"
      description="The guided review continues in this conversation."
      width="min(520px, calc(100vw - 32px))"
      placement={isPhone ? 'bottom' : 'center'}
      onClose={submitting ? undefined : onClose}
      footer={
        <>
          <Button variant="secondary" disabled={submitting} onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={submitting || Boolean(disabledReason)}
            title={disabledReason || undefined}
            onClick={() => void submit()}
          >
            {submitting ? 'Starting…' : 'Start'}
          </Button>
        </>
      }
    >
      <label
        htmlFor={fieldId}
        style={{ display: 'block', marginBottom: 6, fontSize: 'var(--text-sm)', color: 'var(--muted-foreground)' }}
      >
        What should this issue cover?
      </label>
      <textarea
        ref={fieldRef}
        id={fieldId}
        value={value}
        disabled={submitting}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          onValueChange(event.target.value);
          if (error) setError(null);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Describe the problem, the people affected, or the change you have in mind."
        style={{
          display: 'block', boxSizing: 'border-box', width: '100%', minHeight: isPhone ? 136 : 120,
          resize: 'vertical', padding: '10px', borderRadius: 'var(--radius)',
          border: `1px solid ${error ? 'var(--destructive)' : 'var(--border)'}`,
          background: 'var(--input)', color: 'var(--foreground)', outline: 'none',
          // Relay inputs replace the browser outline with this ring. The
          // textarea is bare by design, so it has to take on that job itself.
          boxShadow: focused ? '0 0 0 1px var(--ring)' : 'none',
          borderColor: error ? 'var(--destructive)' : focused ? 'var(--ring)' : 'var(--border)',
          fontFamily: 'var(--font-sans)', fontSize: isPhone ? PHONE_TEXT.input : 'var(--text-ui)',
          lineHeight: 'var(--leading-normal)',
        }}
      />
      <p style={{ margin: '8px 0 0', color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-snug)' }}>
        The agent will ask one focused question at a time, then show the finished issue for your review before filing it.
      </p>
      {disabledReason ? (
        <p role="status" style={{ margin: '10px 0 0', color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)' }}>
          {disabledReason}
        </p>
      ) : null}
      {error ? <p id={errorId} role="alert" style={{ margin: '10px 0 0', color: 'var(--destructive)', fontSize: 'var(--text-sm)' }}>{error}</p> : null}
    </Dialog>
  );
}
