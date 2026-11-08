import { Archive, ArchiveRestore, History, Pencil, Phone } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, errorMessage, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { AuditHistory } from '@/features/audit/AuditHistory';
import { SalesmanFormDialog } from '@/features/salesmen/SalesmanFormDialog';
import { useSalesman, useSalesmanHistory, useUpdateSalesman } from '@/features/salesmen/salesmen-api';
import { formatDateTime } from '@/lib/dates';

const PROFILE_FIELDS: Record<string, string> = { name: 'Name', phone: 'Phone', notes: 'Notes', isActive: 'Active' };
const displayProfile = (field: string, value: unknown) =>
  value === null || value === undefined || value === '' ? '—' : field === 'isActive' ? (value ? 'Yes' : 'No') : String(value);

export function SalesmanDetailPage() {
  const { id = '' } = useParams();
  const salesman = useSalesman(id);
  const update = useUpdateSalesman();
  const toast = useToast();
  const [dialog, setDialog] = useState<'edit' | 'status' | 'history' | null>(null);
  const history = useSalesmanHistory(id, dialog === 'history');

  if (salesman.isPending) return <LoadingState label="Loading salesman…" />;
  if (salesman.isError) return <ErrorState title="Could not load this salesman" error={salesman.error} />;
  const s = salesman.data;

  return (
    <Page width="narrow">
      <PageHeader
        back={{ to: '/salesmen', label: 'Salesmen' }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.name}
            {!s.isActive && <Badge>Deactivated</Badge>}
          </span>
        }
      />

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Details</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setDialog('edit')}>
              <Pencil aria-hidden="true" /> Edit
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog('status')}>
              {s.isActive ? <Archive aria-hidden="true" /> : <ArchiveRestore aria-hidden="true" />}
              {s.isActive ? 'Deactivate' : 'Reactivate'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog('history')}>
              <History aria-hidden="true" /> History
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {s.phone ? (
            <a href={`tel:${s.phone.replace(/[^\d+]/g, '')}`} className="flex items-center gap-2">
              <Phone className="size-4 text-muted-foreground" aria-hidden="true" /> {s.phone}
            </a>
          ) : (
            <p className="text-muted-foreground">No phone number</p>
          )}
          {s.notes && <p className="whitespace-pre-line break-words text-muted-foreground">{s.notes}</p>}
          <dl className="grid gap-1 border-t pt-3 text-xs text-muted-foreground">
            <div>
              <dt className="inline">Added: </dt>
              <dd className="inline">
                {formatDateTime(s.createdAt)} by {s.createdBy.name}
              </dd>
            </div>
            <div>
              <dt className="inline">Last changed: </dt>
              <dd className="inline">
                {formatDateTime(s.updatedAt)} by {s.updatedBy.name}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <SalesmanFormDialog open={dialog === 'edit'} salesman={s} onClose={() => setDialog(null)} onSaved={() => undefined} />
      <Dialog
        open={dialog === 'status'}
        title={s.isActive ? 'Deactivate salesman?' : 'Reactivate salesman?'}
        onClose={() => {
          update.reset();
          setDialog(null);
        }}
        dismissible={!update.isPending}
        size="sm"
        footer={
          <DialogActions>
            <Button variant="outline" disabled={update.isPending} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant={s.isActive ? 'destructive' : 'default'}
              loading={update.isPending}
              onClick={() =>
                update.mutate(
                  { id: s.id, version: s.version, isActive: !s.isActive },
                  {
                    onSuccess: (saved) => {
                      toast({ title: saved.isActive ? 'Salesman reactivated' : 'Salesman deactivated', description: saved.name, tone: 'success' });
                      setDialog(null);
                    },
                    onError: (err) => toast({ title: 'Could not change the status', description: errorMessage(err), tone: 'error' }),
                  },
                )
              }
            >
              {update.isPending ? 'Saving…' : s.isActive ? 'Deactivate' : 'Reactivate'}
            </Button>
          </DialogActions>
        }
      >
        <p className="text-sm">
          {s.isActive
            ? `“${s.name}” will be hidden from the active list. Nothing is deleted: the details and history stay available under “Deactivated”.`
            : `“${s.name}” will appear in the active list again.`}
        </p>
        {update.isError && (
          <p role="alert" className="mt-3 rounded-lg bg-destructive-soft p-3 text-sm text-destructive">
            {errorMessage(update.error)}
          </p>
        )}
      </Dialog>
      <Dialog open={dialog === 'history'} title={`History: ${s.name}`} onClose={() => setDialog(null)}>
        <AuditHistory history={history} fieldLabels={PROFILE_FIELDS} display={displayProfile} />
      </Dialog>
    </Page>
  );
}
