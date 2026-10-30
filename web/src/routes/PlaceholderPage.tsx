import { Construction } from 'lucide-react';
import { Page, PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/states';

export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <Page width="narrow">
      <PageHeader title={title} />
      <EmptyState icon={Construction} title="Not built yet">
        {description}. This module is planned for a later stage.
      </EmptyState>
    </Page>
  );
}
