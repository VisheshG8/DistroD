import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { currentAccount } from "@/lib/server";
import DistributionDashboard from "@/components/distribution-dashboard";

export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
  if (!(await getCurrentUser())) redirect("/login");
  const account = await currentAccount();
  return <DistributionDashboard account={account}/>;
}
