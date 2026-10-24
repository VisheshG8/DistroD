"use client";

import SignOutButton from "@/components/auth/sign-out-button";
import { useEffect, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowUpRight, Check, ChevronLeft, ChevronRight, FileStack, Folder, Layers3, Loader2, LogOut, RefreshCw, Search, ShieldCheck, Users, X } from "lucide-react";

type Account = { id: string; email: string | null; name: string | null; userType: "admin" | "user"; createdAt: string; lastSeenAt: string };
type Section = "pages" | "collections" | "users";
type Summary = { users: number; admins: number; collections: number; pages: number; memberships: number };
type UserRow = Account & { collectionCount: number; pageCount: number };
type Owner = { ownerId: string; ownerEmail: string | null; ownerName: string | null };
type CollectionRow = Owner & { id: string; name: string; createdAt: string; pageCount: number };
type PageRow = Owner & { id: string; platform: string; handle: string; name: string; url: string; followers: number | null; lastSyncedAt: string | null; hasSyncError: boolean; selectedPostCount: number; views: number | null; likes: number | null; comments: number | null; shares: number | null; collectionCount: number; coverage: { mode: string | null; limit: number | null; from: string | null; to: string | null; complete: boolean } };
type Result = { section: Section; items: (UserRow | CollectionRow | PageRow)[]; total: number; limit: number; offset: number; hasMore: boolean; summary: Summary; collection?: CollectionRow; error?: string };
type Filter = { id: string; label: string } | null;
const labels: Record<Section, string> = { pages: "Pages", collections: "Collections", users: "People" };
const number = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("en").format(value);
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "Not available";
const platform = (value: string) => value === "youtube" ? "YouTube" : value === "instagram" ? "Instagram" : value === "tiktok" ? "TikTok" : value;
const initials = (value: string) => value.replace(/^@/, "").slice(0, 2).toUpperCase();

export default function AdminDashboard({ account }: { account: Account }) {
  const [section, setSection] = useState<Section>("pages"), [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0), [ownerFilter, setOwnerFilter] = useState<Filter>(null), [collectionFilter, setCollectionFilter] = useState<Filter>(null);
  const [result, setResult] = useState<Result | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const params = new URLSearchParams({ section, limit: "25", offset: String(offset) });
    if (search) params.set("search", search);
    if (ownerFilter) params.set("ownerId", ownerFilter.id);
    if (collectionFilter && section === "pages") params.set("collectionId", collectionFilter.id);
    fetch("/api/admin?" + params, { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json() as Result;
      if (!response.ok) throw new Error(response.status === 401 ? "Your session ended. Sign in again to continue." : response.status === 403 ? "This account no longer has admin access." : payload.error || "The admin records could not be loaded.");
      setResult(payload);
    }).catch(cause => { if (!controller.signal.aborted) { setResult(null); setError(cause instanceof Error ? cause.message : "The records could not be loaded."); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [section, offset, search, ownerFilter, collectionFilter, revision]);

  function chooseSection(next: Section) {
    setSection(next); setOffset(0); setQuery(""); setSearch(""); setOwnerFilter(null); setCollectionFilter(null);
  }
  function inspectCollection(collection: CollectionRow) {
    setSection("pages"); setCollectionFilter({ id: collection.id, label: collection.name }); setOwnerFilter(null); setOffset(0); setQuery(""); setSearch("");
  }
  function inspectOwner(owner: Owner | UserRow, next: Section = "collections") {
    const user = "ownerId" in owner ? { id: owner.ownerId, label: owner.ownerEmail || owner.ownerName || owner.ownerId } : { id: owner.id, label: owner.email || owner.name || owner.id };
    setOwnerFilter(user); setCollectionFilter(null); setSection(next); setOffset(0); setQuery(""); setSearch("");
  }
  function renderOwner(row: Owner) {
    return <button className="adm-owner" onClick={() => inspectOwner(row)} title="View this person's collections"><strong>{row.ownerName || row.ownerEmail || "Profile not registered"}</strong>{row.ownerEmail && <span>{row.ownerEmail}</span>}{!row.ownerEmail && <span className="adm-id">{row.ownerId}</span>}</button>;
  }
  function coverage(row: PageRow) {
    if (!row.lastSyncedAt) return "Not fetched";
    const scope = row.coverage;
    if (!scope) return "No saved selection";
    if (scope.mode === "date") return date(scope.from) + " – " + date(scope.to ? new Date(Date.parse(scope.to) - 1).toISOString() : null);
    return scope.limit ? "Latest " + scope.limit + " posts" : number(row.selectedPostCount) + " saved posts";
  }
  const summary = result?.summary;
  const displayName = account.name || account.email || "Admin";
  const count = section === "pages" ? summary?.pages : section === "collections" ? summary?.collections : summary?.users;
  const items = result?.items || [];
  return <div className="adm-app">
    <aside className="adm-sidebar">
      <a className="adm-brand" href="/dashboard"><span><Layers3 size={23} /></span><div>Distribution<br />Desk<span>.</span></div></a>
      <div className="adm-access"><ShieldCheck size={17} /><span>Admin workspace<small>All registered workspaces</small></span></div>
      <div className="adm-nav-label">WORKSPACE DIRECTORY</div>
      <nav aria-label="Admin sections">{(["pages", "collections", "users"] as Section[]).map(key => { const Icon = key === "pages" ? FileStack : key === "collections" ? Folder : Users; return <button key={key} className={section === key ? "active" : ""} onClick={() => chooseSection(key)} aria-current={section === key ? "page" : undefined}><Icon size={18} /><span>{labels[key]}</span><small>{number(key === "pages" ? summary?.pages : key === "collections" ? summary?.collections : summary?.users)}</small></button>; })}</nav>
      <div className="adm-sidebar-bottom"><a href="/dashboard"><ArrowLeft size={16} />My workspace</a><SignOutButton className="adm-signout"><LogOut size={16} />Sign out</SignOutButton><div className="adm-profile"><span>{initials(displayName)}</span><div><strong>{displayName}</strong><small>{account.email}</small></div></div></div>
    </aside>
    <main className="adm-main">
      <header className="adm-topbar"><div>Administration<span>/</span><strong>{labels[section]}</strong></div><span className="adm-private"><ShieldCheck size={13} />ADMIN ACCESS</span></header>
      <div className="adm-content">
        <div className="adm-heading"><div><span className="adm-eyebrow">ONE VIEW ACROSS EVERY WORKSPACE</span><h1>Workspace directory<span>.</span></h1><p>See the people, collections, and public pages added to Distribution Desk.</p></div><a href="/dashboard" className="adm-button">Open my workspace<ArrowUpRight size={15} /></a></div>
        <div className="adm-stats">{[{ name: "People", value: summary?.users, icon: Users, detail: (summary?.admins ?? 0) + " with admin access" }, { name: "Collections", value: summary?.collections, icon: Folder, detail: "Groups created across all users" }, { name: "Tracked pages", value: summary?.pages, icon: FileStack, detail: "Page records across all users" }].map(item => <div className="adm-stat" key={item.name}><div><span>{item.name}</span><item.icon size={19} /></div><strong>{number(item.value)}</strong><small>{item.detail}</small></div>)}</div>
        <section className="adm-panel" aria-label={labels[section] + " directory"}>
          <div className="adm-panel-heading"><div><h2>{labels[section]}</h2><span>{number(count)}</span></div><button className="adm-button" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} className={loading ? "spin" : ""} />Refresh</button></div>
          <div className="adm-mobile-tabs" aria-label="Admin sections">{(["pages", "collections", "users"] as Section[]).map(key => <button key={key} className={section === key ? "active" : ""} aria-pressed={section === key} onClick={() => chooseSection(key)}>{labels[key]}</button>)}</div>
          {(ownerFilter || collectionFilter) && <div className="adm-filter-context"><span>Showing {collectionFilter ? "pages in " + collectionFilter.label : "records added by " + ownerFilter?.label}</span>{ownerFilter && <div><button className={section === "collections" ? "active" : ""} onClick={() => { setSection("collections"); setOffset(0); }}>Collections</button><button className={section === "pages" ? "active" : ""} onClick={() => { setSection("pages"); setOffset(0); }}>Pages</button></div>}<button aria-label="Clear owner and collection filters" onClick={() => { setOwnerFilter(null); setCollectionFilter(null); setOffset(0); }}><X size={15} /></button></div>}
          <form className="adm-toolbar" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setOffset(0); }}><label className="adm-search"><Search size={17} /><input aria-label={"Search " + labels[section].toLowerCase()} placeholder={section === "users" ? "Search by name or email" : "Search names, handles, or owner email"} value={query} onChange={event => setQuery(event.target.value)} /></label><button className="adm-button" type="submit">Search</button>{search && <button type="button" className="adm-clear" onClick={() => { setQuery(""); setSearch(""); setOffset(0); }}>Clear search<X size={13} /></button>}</form>
          {error ? <div className="adm-error" role="alert"><AlertCircle size={21} /><div><strong>Could not load records</strong><p>{error}</p><button className="adm-button" onClick={() => setRevision(value => value + 1)}>Try again</button></div></div> : loading ? <div className="adm-loading" role="status"><Loader2 size={23} className="spin" />Loading {labels[section].toLowerCase()}…</div> : !items.length ? <div className="adm-empty"><Folder size={30} /><h3>{search || ownerFilter || collectionFilter ? "No matching records" : "No " + labels[section].toLowerCase() + " yet"}</h3><p>{search ? "Try another name, handle, or email address." : "Records will appear here when people add them to their workspace."}</p></div> : <div className="adm-table-scroll" role="region" aria-label={labels[section] + " records"} tabIndex={0}>
            {section === "pages" ? <table className="adm-table adm-pages-table"><thead><tr><th scope="col">Page</th><th scope="col">Added by</th><th scope="col" className="adm-numeric">Followers</th><th scope="col" className="adm-numeric">Selected views</th><th scope="col" className="adm-numeric">Posts</th><th scope="col">Saved selection</th><th scope="col">Last refresh</th><th scope="col" aria-label="Open page" /></tr></thead><tbody>{(items as PageRow[]).map(row => <tr key={row.id}><th scope="row"><div className="adm-page-name"><span>{initials(row.name || row.handle)}</span><div><strong>{row.name || row.handle}</strong><small>@{row.handle}</small><small className={"adm-platform adm-platform-" + row.platform}>{platform(row.platform)}</small></div></div></th><td>{renderOwner(row)}</td><td className="adm-numeric">{number(row.followers)}</td><td className="adm-numeric"><strong>{number(row.views)}</strong><small>On saved selected posts</small></td><td className="adm-numeric">{number(row.lastSyncedAt ? row.selectedPostCount : null)}<small>{number(row.collectionCount)} {row.collectionCount === 1 ? "collection" : "collections"}</small></td><td><span>{coverage(row)}</span><small className={row.coverage?.complete ? "adm-status" : "adm-status adm-status-pending"}>{row.lastSyncedAt ? row.coverage?.complete ? "Complete selection" : "Partial selection" : "Not refreshed"}</small></td><td>{row.lastSyncedAt ? date(row.lastSyncedAt) : "Not refreshed"}{row.hasSyncError && <small className="adm-status adm-status-pending">Needs attention</small>}</td><td><a href={/^https:\/\//i.test(row.url) ? row.url : "#"} target="_blank" rel="noopener noreferrer" className="adm-icon-link" aria-label={"Open " + row.handle + " on " + platform(row.platform)}><ArrowUpRight size={17} /></a></td></tr>)}</tbody></table> : section === "collections" ? <table className="adm-table"><thead><tr><th scope="col">Collection</th><th scope="col">Added by</th><th scope="col" className="adm-numeric">Pages</th><th scope="col">Created</th><th scope="col" aria-label="Collection details" /></tr></thead><tbody>{(items as CollectionRow[]).map(row => <tr key={row.id}><th scope="row"><div className="adm-collection-name"><span><Folder size={18} /></span><strong>{row.name}</strong></div></th><td>{renderOwner(row)}</td><td className="adm-numeric">{number(row.pageCount)}</td><td>{date(row.createdAt)}</td><td><button className="adm-row-link" onClick={() => inspectCollection(row)}>View pages<ArrowUpRight size={14} /></button></td></tr>)}</tbody></table> : <table className="adm-table"><thead><tr><th scope="col">Person</th><th scope="col">User type</th><th scope="col" className="adm-numeric">Collections</th><th scope="col" className="adm-numeric">Pages</th><th scope="col">Joined</th><th scope="col">Last active</th><th scope="col" aria-label="Person details" /></tr></thead><tbody>{(items as UserRow[]).map(row => <tr key={row.id}><th scope="row"><div className="adm-page-name"><span>{initials(row.name || row.email || "U")}</span><div><strong>{row.name || row.email || "Profile not registered"}</strong>{row.email && <small>{row.email}</small>}<small className="adm-id" title={row.id}>{row.id}</small></div></div></th><td><span className={"adm-role " + (row.userType === "admin" ? "adm-role-admin" : "")}>{row.userType === "admin" && <ShieldCheck size={12} />}{row.userType === "admin" ? "Admin" : "User"}</span></td><td className="adm-numeric">{number(row.collectionCount)}</td><td className="adm-numeric">{number(row.pageCount)}</td><td>{date(row.createdAt)}</td><td>{date(row.lastSeenAt)}</td><td><button className="adm-row-link" onClick={() => inspectOwner(row)}>View records<ArrowUpRight size={14} /></button></td></tr>)}</tbody></table>}
          </div>}
          {!loading && !error && result && <div className="adm-pagination"><span>{result.total ? number(result.offset + 1) + "–" + number(result.offset + result.items.length) + " of " + number(result.total) : "0 records"}{search ? " matching your search" : ""}</span><div><button className="adm-button" disabled={result.offset === 0} onClick={() => setOffset(Math.max(0, result.offset - result.limit))}><ChevronLeft size={15} />Previous</button><button className="adm-button" disabled={!result.hasMore} onClick={() => setOffset(result.offset + result.limit)}>Next<ChevronRight size={15} /></button></div></div>}
        </section>
        <div className="adm-note"><Check size={15} /><p>Owner details come from registered accounts. Each person's pages and collections remain in their own workspace.</p></div>
        <footer className="adm-footer"><strong>Distribution Desk<span>.</span></strong><span>Workspace directory · Admin access</span></footer>
      </div>
    </main>
  </div>;
}
