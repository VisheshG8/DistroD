import AnalyticsDashboard from '@/components/analytics-dashboard';
import { createDemoDataset } from '@/lib/analytics/demo';
import { PRODUCT_NAME } from '@/lib/product';

export const dynamic = 'force-dynamic';
export const metadata = { title: `Demo · ${PRODUCT_NAME}`, robots: { index: false, follow: false } };

export default function DemoPage() {
  return <AnalyticsDashboard
    account={{ id: 'demo', email: null, name: 'Sample workspace', userType: 'user' }}
    initialDataset={createDemoDataset()}
    demo
  />;
}
