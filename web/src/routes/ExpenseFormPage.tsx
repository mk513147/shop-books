import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { ErrorState, LoadingState } from '@/components/states';
import { useCategories } from '@/features/categories/categories-api';
import { useCreateExpense, useExpense, useUpdateExpense } from '@/features/expenses/expenses-api';
import { ExpenseForm } from '@/features/expenses/ExpenseForm';
import { newIdempotencyKey } from '@/lib/ids';

export function NewExpensePage() {
  const navigate = useNavigate();
  const categories = useCategories('active');
  const create = useCreateExpense();
  // One key per opened form: every retry of this form is the same request to the server.
  const [idempotencyKey] = useState(newIdempotencyKey);

  return (
    <Page width="medium">
      <PageHeader title="Add expense" back={{ to: '/expenses', label: 'Expenses' }} />
      {categories.isPending && <LoadingState label="Loading categories…" />}
      {categories.isError && <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />}
      {categories.isSuccess && (
        <ExpenseForm
          categories={categories.data}
          submitLabel="Save expense"
          cancelTo="/expenses"
          onSubmit={(input) => create.mutateAsync({ ...input, idempotencyKey })}
          onDone={(expense, notice) => navigate(`/expenses/${expense.id}`, { state: { notice } })}
        />
      )}
    </Page>
  );
}

export function EditExpensePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const expense = useExpense(id);
  const categories = useCategories('active');
  const update = useUpdateExpense();

  if (expense.isPending || categories.isPending) return <LoadingState label="Loading expense…" />;
  if (expense.isError) return <ErrorState title="Could not load this expense" error={expense.error} />;
  if (categories.isError) return <ErrorState error={categories.error} onRetry={() => void categories.refetch()} />;

  const current = expense.data;
  if (current.status === 'voided') {
    return (
      <ErrorState title="This expense is voided">
        <p>Restore it from the expense details page before editing.</p>
      </ErrorState>
    );
  }

  return (
    <Page width="medium">
      <PageHeader title="Edit expense" back={{ to: `/expenses/${current.id}`, label: 'Expense details' }} />
      <ExpenseForm
        initial={current}
        categories={categories.data}
        submitLabel="Save changes"
        cancelTo={`/expenses/${current.id}`}
        onSubmit={(input, baseVersion) => update.mutateAsync({ id: current.id, version: baseVersion ?? current.version, ...input })}
        onDone={(expense, notice) => navigate(`/expenses/${expense.id}`, { state: { notice } })}
      />
    </Page>
  );
}
