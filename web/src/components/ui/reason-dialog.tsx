import { useEffect, useId, useState } from 'react';
import { Button } from './button';
import { Dialog, DialogActions } from './dialog';
import { Label } from './label';
import { Textarea } from './select';

interface ReasonDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  /** Button text while the request runs; defaults to the confirm verb + "ing" ("Voiding…"). */
  pendingLabel?: string;
  error?: string | null;
  destructive?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/** "Void expense" -> "Voiding…", "Remove document" -> "Removing…". */
function progressive(label: string): string {
  const verb = label.split(' ')[0] ?? label;
  return `${verb.endsWith('e') ? verb.slice(0, -1) : verb}ing…`;
}

/** Confirmation that requires a written reason (void / restore). */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  pendingLabel,
  error,
  destructive = false,
  onConfirm,
  onCancel,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const id = useId();
  const formId = `${id}-form`;

  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  const empty = reason.trim().length === 0;

  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      dismissible={!pending}
      size="sm"
      footer={
        <DialogActions>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant={destructive ? 'destructive' : 'default'} loading={pending}>
            {pending ? (pendingLabel ?? progressive(confirmLabel)) : confirmLabel}
          </Button>
        </DialogActions>
      }
    >
      <form
        id={formId}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!empty) onConfirm(reason.trim());
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-reason`}>Reason (required)</Label>
          <Textarea
            id={`${id}-reason`}
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={touched && empty ? true : undefined}
          />
          {touched && empty && <p className="text-sm text-destructive">Enter a reason</p>}
        </div>
        {error && (
          <p role="alert" className="rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
