import { Camera, CheckCircle2, FileText, Paperclip, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '@/components/states';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { uploadExpenseDocument } from './documents-api';
import { checkFile, DOCUMENT_ACCEPT, formatBytes, isImageName } from './limits';

export interface PendingFile {
  key: string;
  file: File;
  /** Object URL for image previews (revoked when the file is removed or the form unmounts). */
  previewUrl: string | null;
  status: 'ready' | 'uploading' | 'done' | 'failed';
  progress: number;
  error: string | null;
}

let counter = 0;

/**
 * Files chosen in a form but not uploaded yet. Uploading happens only after the expense itself was
 * saved; failed files stay in the list (with their error) so they can be retried without losing
 * anything the user entered.
 */
export function usePendingFiles(
  options: {
    /** Files accepted by `add` (e.g. to keep a draft copy on the device). */
    onAdded?: (files: PendingFile[]) => void;
    /** A file removed by the user. */
    onRemoved?: (key: string) => void;
  } = {},
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;

  useEffect(
    () => () => {
      for (const f of filesRef.current) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    },
    [],
  );

  const add = useCallback((list: File[], maxCount: number): PendingFile[] => {
    const problems: string[] = [];
    const accepted: PendingFile[] = [];
    const current = filesRef.current;
    for (const file of list) {
      const problem = checkFile(file);
      if (problem) {
        problems.push(problem);
        continue;
      }
      if (current.some((f) => f.file.name === file.name && f.file.size === file.size && f.file.lastModified === file.lastModified)) {
        problems.push(`${file.name}: already selected.`);
        continue;
      }
      if (current.length + accepted.length >= maxCount) {
        problems.push(`${file.name}: an expense can have at most 10 documents.`);
        continue;
      }
      accepted.push({
        key: `f${++counter}`,
        file,
        previewUrl: isImageName(file.name) ? URL.createObjectURL(file) : null,
        status: 'ready',
        progress: 0,
        error: null,
      });
    }
    setRejected(problems);
    if (accepted.length) {
      setFiles((prev) => [...prev, ...accepted]);
      optionsRef.current.onAdded?.(accepted);
    }
    return accepted;
  }, []);

  const remove = useCallback((key: string) => {
    setFiles((prev) => {
      const target = prev.find((f) => f.key === key);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((f) => f.key !== key);
    });
    optionsRef.current.onRemoved?.(key);
  }, []);

  const patch = (key: string, change: Partial<PendingFile>) =>
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...change } : f)));

  /** Uploads every file that is not done yet, one at a time. Resolves with the number that failed. */
  const uploadAll = useCallback(async (expenseId: string): Promise<number> => {
    let failed = 0;
    for (const item of filesRef.current.filter((f) => f.status !== 'done')) {
      patch(item.key, { status: 'uploading', progress: 0, error: null });
      try {
        await uploadExpenseDocument(expenseId, item.file, (p) => patch(item.key, { progress: p }));
        patch(item.key, { status: 'done', progress: 1 });
      } catch (err) {
        failed += 1;
        patch(item.key, { status: 'failed', error: errorMessage(err) });
      }
    }
    return failed;
  }, []);

  /** Marks files as handled elsewhere (e.g. saved in the offline queue): they are not sent again. */
  const markDone = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setFiles((prev) => prev.map((f) => (keys.includes(f.key) ? { ...f, status: 'done' as const, progress: 1, error: null } : f)));
  }, []);

  const clear = useCallback(() => {
    for (const f of filesRef.current) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    setFiles([]);
    setRejected([]);
  }, []);

  return {
    files,
    rejected,
    add,
    remove,
    uploadAll,
    markDone,
    clear,
    uploading: files.some((f) => f.status === 'uploading'),
    pendingCount: files.filter((f) => f.status !== 'done').length,
  };
}

export type PendingFiles = ReturnType<typeof usePendingFiles>;

function Thumb({ name, previewUrl }: { name: string; previewUrl: string | null }) {
  if (previewUrl) return <img src={previewUrl} alt="" className="size-12 shrink-0 rounded-md border object-cover" />;
  return (
    <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-md border bg-surface-muted text-muted-foreground">
      <FileText className="size-5" aria-hidden="true" />
      <span className="sr-only">{name.toLowerCase().endsWith('.pdf') ? 'PDF document' : 'File'}</span>
    </span>
  );
}

/** "Choose files" (multiple) everywhere, plus "Take photo" (rear camera) on phones. */
export function FileChooserButtons({
  onFiles,
  disabled,
  hintId,
}: {
  onFiles: (files: File[]) => void;
  disabled: boolean;
  hintId?: string;
}) {
  const chooseRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const onPick = (input: HTMLInputElement | null) => {
    if (!input?.files) return;
    const files = Array.from(input.files);
    input.value = ''; // allow choosing the same file again after removing it
    onFiles(files);
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => chooseRef.current?.click()} aria-describedby={hintId}>
        <Paperclip aria-hidden="true" /> Choose files
      </Button>
      <Button variant="outline" size="sm" className="md:hidden" disabled={disabled} onClick={() => cameraRef.current?.click()}>
        <Camera aria-hidden="true" /> Take photo
      </Button>
      <input ref={chooseRef} type="file" multiple accept={DOCUMENT_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => onPick(e.currentTarget)} />
      <input ref={cameraRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => onPick(e.currentTarget)} />
    </div>
  );
}

/**
 * Choose bill photos/PDFs: "Choose files" (multiple) everywhere, plus "Take photo" (rear camera)
 * on phones. Shows a small preview, name, type, size and per-file upload state.
 */
export function DocumentPicker({
  pending,
  maxCount,
  disabled = false,
}: {
  pending: PendingFiles;
  /** How many more documents the expense may receive (10 minus those already attached). */
  maxCount: number;
  disabled?: boolean;
}) {
  const id = useId();
  const full = pending.files.length >= maxCount;
  const locked = disabled || pending.uploading;

  return (
    <div className="space-y-3">
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        Optional. Photos (JPEG, PNG, WebP) or PDF, up to 10 MB each
        {maxCount < 10 ? ` (${Math.max(0, maxCount)} more allowed)` : ', at most 10 per expense'}.
      </p>
      <FileChooserButtons onFiles={(files) => pending.add(files, maxCount)} disabled={locked || full} hintId={`${id}-hint`} />

      {pending.rejected.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
          {pending.rejected.map((m) => (
            <li key={m} className="break-words">
              {m}
            </li>
          ))}
        </ul>
      )}

      {pending.files.length > 0 && (
        <ul className="space-y-2" aria-label="Selected files">
          {pending.files.map((f) => (
            <li key={f.key} className={cn('flex items-center gap-3 rounded-lg border bg-card p-2', f.status === 'failed' && 'border-destructive/40')}>
              <Thumb name={f.file.name} previewUrl={f.previewUrl} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{f.file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {f.file.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'Photo'} · {formatBytes(f.file.size)}
                  {f.status === 'done' && <span className="text-primary"> · Uploaded</span>}
                </p>
                {f.status === 'uploading' && (
                  <div
                    role="progressbar"
                    aria-label={`Uploading ${f.file.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(f.progress * 100)}
                    className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary"
                  >
                    <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(f.progress * 100)}%` }} />
                  </div>
                )}
                {f.status === 'failed' && <p className="mt-0.5 text-xs break-words text-destructive">{f.error}</p>}
              </div>
              {f.status === 'done' ? (
                <CheckCircle2 className="size-5 shrink-0 text-primary" aria-label="Uploaded" />
              ) : (
                <Button variant="ghost" size="icon" aria-label={`Remove ${f.file.name}`} disabled={locked} onClick={() => pending.remove(f.key)}>
                  <X aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
