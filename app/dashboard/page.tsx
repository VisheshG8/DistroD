import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { currentAccount } from "@/lib/server";
import AnalyticsDashboard from "@/components/analytics-dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!(await getCurrentUser())) redirect("/login");
  const account = await currentAccount();
  return <AnalyticsDashboard account={account}/>;
}
