// Links: where messages can send customers. Its own page, not part of the
// Knowledge Base: links are run day to day by the bank's team (URLs, short
// links, retiring one), not knowledge the designer reasons with.
import { LinksSection } from './LinksSection';
import type { Tenant } from './types';

export function LinksView({ tenant }: { tenant: Tenant | null }) {
  return (
    <div className="cd-page cd-links-page">
      <LinksSection tenant={tenant} />
    </div>
  );
}
