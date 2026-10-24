import { redirect } from "next/navigation";
import { ApiError, requireAdmin } from "@/lib/server";
import AdminDashboard from "@/components/admin-dashboard";
import "./admin.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin workspace · Distribution Desk" };

export default async function AdminPage() {
  let account;
  try { account = await requireAdmin(); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/login");
    if (error instanceof ApiError && error.status === 403) redirect("/dashboard");
    throw error;
  }
  return <AdminDashboard account={account} />;
}
