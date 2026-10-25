"use client";

import SignOutButton from "@/components/auth/sign-out-button";
import AdminRecordActions from "@/components/admin-record-actions";
import { Fragment, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, FileStack, Folder, Layers3, Loader2, LogOut, RefreshCw, Search, ShieldCheck, Users, X } from "lucide-react";

type Account = { id: string; email: string | null; name: string | null; userType: "admin" | "user"; createdAt: string; lastSeenAt: string };
type Section = "pages" | "collections" | "users";
type Summary = { users: number; admins: number; collections: number; pages: number; memberships: number };
type UserRow = Account & { collectionCount: number; pageCount: number };
type Owner = { ownerId: string; ownerEmail: string | null; ownerName: string | null };
type CollectionRow = Owner & { id: string; name: string; createdAt: string; pageCount: number };
type PostMetric = "views" | "likes" | "comments" | "shares";
type PageRow = Owner & {
  id: string; platform: string; handle: string; name: string; url: string;
  followers: number | null; lastSyncedAt: string | null; hasSyncError: boolean;
  selectedPostCount: number; views: number | null; likes: number | null; comments: number | null; shares: number | null;
  lifetimeViews: number | null; lifetimePosts: number | null; collectionCount: number;
  collections?: { id: string; name: string }[];
  metricCoverage?: Partial<Record<PostMetric, { known: number; total: number }>>;
  coverage: { mode: string | null; limit: number | null; from: string | null; to: string | null; complete: boolean };
};
type Result = { section: Section; items: (UserRow | CollectionRow | PageRow)[]; total: number; limit: number; offset: number; hasMore: boolean; summary: Summary; collection?: CollectionRow; error?: string };
type OwnerFilter = { id: string; label: string; email: string | null };
type CollectionFilter = { id: string; label: string };
const sections: Section[] = ["users", "collections", "pages"];
const labels: Record<Section, string> = { pages: "Pages", collections: "Collections", users: "People" };
const number = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : new Intl.NumberFormat("en").format(value);
function date(value: string | null | undefined, exact = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not available";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
    ...(exact ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false } as const : {}),
  }) + (exact ? " IST" : "");
}
const platform = (value: string) => value === "youtube" ? "YouTube" : value === "instagram" ? "Instagram" : value === "tiktok" ? "TikTok" : value;
const initials = (value: string) => value.replace(/^@/, "").slice(0, 2).toUpperCase();
function ownerInfo(row: Owner | UserRow): OwnerFilter {
  return "ownerId" in row
    ? { id: row.ownerId, label: row.ownerName || row.ownerEmail || "Unnamed account", email: row.ownerEmail }
    : { id: row.id, label: row.name || row.email || "Unnamed account", email: row.email };
}
function coverage(row: PageRow) {
  if (!row.lastSyncedAt) return "Not refreshed";
  const scope = row.coverage;
  if (!scope) return "No saved selection";
  if (scope.mode === "date") {
    const end = scope.to ? Date.parse(scope.to) : NaN;
    const inclusiveEnd = new Date(end - 1);
    return date(scope.from) + " – " + date(Number.isFinite(inclusiveEnd.getTime()) ? inclusiveEnd.toISOString() : null);
  }
  return scope.limit ? "Latest " + scope.limit + " posts" : number(row.selectedPostCount) + " saved posts";
}
function metricNote(row: PageRow, metric: PostMetric) {
  const count = row.metricCoverage?.[metric];
  if (!row.lastSyncedAt || row[metric] == null) return "Unavailable";
  if (count && count.known < count.total) return "Available for " + number(count.known) + " of " + number(count.total) + " saved posts";
  return "On saved selected posts";
}

export default function AdminDashboard({ account }: { account: Account }) {
  const [section, setSection] = useState<Section>("users");
  const [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter | null>(null);
  const [collectionFilter, setCollectionFilter] = useState<CollectionFilter | null>(null);
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const [report, setReport] = useState<{ key: string; data: Result } | null>(null);
  const [fetching, setFetching] = useState(true);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const recovery = useRef({ key: "", attempted: false });
  const requestKey = JSON.stringify([section, offset, search, ownerFilter?.id, collectionFilter?.id, revision]);
  // Navigation renders before its effect runs. Never interpret old rows as a new section.
  const result = report?.key === requestKey ? report.data : null;
  const error = failure?.key === requestKey ? failure.message : "";
  const loading = fetching || (!result && !error);

  useEffect(() => {
    const controller = new AbortController();
    let recovering = false;
    const recoveryKey = JSON.stringify([section, search, ownerFilter?.id, collectionFilter?.id, revision]);
    if (recovery.current.key !== recoveryKey) recovery.current = { key: recoveryKey, attempted: false };
    setFetching(true); setFailure(null); setExpandedPage(null);
    const params = new URLSearchParams({ section, limit: "25", offset: String(offset) });
    if (search) params.set("search", search);
    if (ownerFilter) params.set("ownerId", ownerFilter.id);
    if (collectionFilter && section === "pages") params.set("collectionId", collectionFilter.id);
    fetch("/api/admin?" + params, { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json() as Result;
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(response.status === 401 ? "Your session ended. Sign in again to continue." : response.status === 403 ? "This account no longer has admin access." : payload.error || "The admin records could not be loaded.");
      // A deletion in another workspace can make the last directory page disappear.
      if (offset > 0 && !payload.items.length && offset >= payload.total && !recovery.current.attempted) {
        recovery.current.attempted = true; recovering = true;
        setOffset(Math.max(0, Math.floor((payload.total - 1) / payload.limit) * payload.limit));
        return;
      }
      setReport({ key: requestKey, data: payload });
    }).catch(cause => {
      if (!controller.signal.aborted) { setReport(null); setFailure({ key: requestKey, message: cause instanceof Error ? cause.message : "The records could not be loaded." }); }
    }).finally(() => { if (!controller.signal.aborted && !recovering) setFetching(false); });
    return () => controller.abort();
  }, [section, offset, search, ownerFilter, collectionFilter, revision, requestKey]);

  function resetSearch() { setOffset(0); setQuery(""); setSearch(""); setExpandedPage(null); }
  function chooseSection(next: Section) {
    setSection(next); setOwnerFilter(null); setCollectionFilter(null); resetSearch();
  }
  function chooseOwnerSection(next: "pages" | "collections") {
    setSection(next); setCollectionFilter(null); resetSearch();
  }
  function inspectCollection(collection: Pick<CollectionRow, "id" | "name"> & Owner) {
    setSection("pages"); setCollectionFilter({ id: collection.id, label: collection.name });
    setOwnerFilter(ownerInfo(collection)); resetSearch();
  }
  function inspectOwner(owner: Owner | UserRow, next: "pages" | "collections" = "collections") {
    setOwnerFilter(ownerInfo(owner)); setCollectionFilter(null); setSection(next); resetSearch();
  }
  function renderOwner(row: Owner) {
    return <button className="adm-owner" onClick={() => inspectOwner(row)} aria-label={"Collections for " + (row.ownerName || row.ownerEmail || row.ownerId)}>
      <strong>{row.ownerName || row.ownerEmail || "Unnamed account"}</strong>
      {row.ownerEmail && <span>{row.ownerEmail}</span>}
      {!row.ownerEmail && <span className="adm-id">{row.ownerId}</span>}
      <span className="adm-owner-action">Collections <ChevronRight size={12} /></span>
    </button>;
  }
  function renderPage(row: PageRow) {
    const expanded = expandedPage === row.id;
    const detailId = "page-details-" + row.id;
    return <Fragment key={row.id}>
      <tr className={expanded ? "adm-row-expanded" : undefined}>
        <th scope="row"><div className="adm-page-name"><span>{initials(row.name || row.handle)}</span><div>
          <strong>{row.name || row.handle}</strong><small>@{row.handle}</small>
          <small className={"adm-platform adm-platform-" + row.platform}>{platform(row.platform)}</small>
          <button className="adm-row-link adm-details-toggle" aria-expanded={expanded} aria-controls={detailId} aria-label={(expanded ? "Hide" : "Show") + " metrics for " + (row.name || row.handle)} onClick={() => setExpandedPage(expanded ? null : row.id)}>Metrics<ChevronDown size={15} /></button>
        </div></div></th>
        <td>{renderOwner(row)}</td>
        <td className="adm-numeric">{number(row.followers)}</td>
        <td className="adm-numeric"><strong>{number(row.views)}</strong><small>{metricNote(row, "views")}</small></td>
        <td className="adm-numeric">{number(row.lastSyncedAt ? row.selectedPostCount : null)}<small>{number(row.collectionCount)} {row.collectionCount === 1 ? "collection" : "collections"}</small></td>
        <td><span>{coverage(row)}</span><small className={row.coverage?.complete ? "adm-status" : "adm-status adm-status-pending"}>{row.lastSyncedAt ? row.coverage?.complete ? "Complete selection" : "Partial selection" : "Not refreshed"}</small></td>
        <td>{row.lastSyncedAt ? date(row.lastSyncedAt) : "Not refreshed"}{row.hasSyncError && <small className="adm-status adm-status-pending">Needs attention</small>}</td>
        <td>{/^https:\/\//i.test(row.url) && <a href={row.url} target="_blank" rel="noopener noreferrer" className="adm-icon-link" aria-label={"Open " + row.handle + " on " + platform(row.platform)}><ArrowUpRight size={17} /></a>}</td>
      </tr>
      {expanded && <tr className="adm-details-row"><td colSpan={8}><section id={detailId} className="adm-page-details" aria-label={"Saved metrics for " + (row.name || row.handle)}>
        <div className="adm-details-heading"><div><h3>{row.name || row.handle}</h3><p>Last refreshed: {row.lastSyncedAt ? date(row.lastSyncedAt, true) : "Not refreshed"}</p></div>
          <AdminRecordActions ownerId={row.ownerId} label={row.ownerName || row.ownerEmail || row.ownerId} pageId={row.id} pageName={row.name || row.handle} onDone={() => setRevision(value => value + 1)} />
          {/^https:\/\//i.test(row.url) && <a href={row.url} target="_blank" rel="noopener noreferrer" className="adm-button">Open on {platform(row.platform)}<ArrowUpRight size={14} /></a>}
        </div>
        <div className="adm-metric-groups">
          <div><h4>Saved post selection</h4><p>{coverage(row)}</p><dl className="adm-metric-grid">
            {(["views", "likes", "comments", "shares"] as PostMetric[]).map(metric => <div key={metric}><dt>{metric[0].toUpperCase() + metric.slice(1)}</dt><dd>{number(row[metric])}</dd><small>{metricNote(row, metric)}</small></div>)}
          </dl></div>
          <div><h4>Profile totals</h4><p>Separate from the selected posts</p><dl className="adm-metric-grid adm-profile-metrics">
            {[{ label: "Followers / subscribers", value: row.followers }, { label: "Lifetime views", value: row.lifetimeViews }, { label: "Lifetime posts", value: row.lifetimePosts }].map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{number(metric.value)}</dd></div>)}
          </dl></div>
        </div>
        <div className="adm-page-collections"><strong>Collections</strong>{row.collections ? row.collections.length ? <div>{row.collections.map(collection => <button key={collection.id} className="adm-collection-chip" onClick={() => inspectCollection({ ...collection, ownerId: row.ownerId, ownerName: row.ownerName, ownerEmail: row.ownerEmail })}><Folder size={13} />{collection.name}<ChevronRight size={13} /></button>)}</div> : <span>No collections</span> : <button className="adm-row-link" onClick={() => inspectOwner(row)}>Collections for this account<ChevronRight size={13} /></button>}</div>
        <p className="adm-metric-note">Post metrics are lifetime counts on the saved selected posts. A date selection does not measure views earned during those dates. A dash means unavailable; zero is a reported count.</p>
      </section></td></tr>}
    </Fragment>;
  }

  const summary = report?.data.summary;
  const displayName = account.name || account.email || "Admin";
  const items = result?.items || [];
  const scoped = !!(ownerFilter || collectionFilter || search);
  const cards = [
    { section: "users" as const, name: "People", value: summary?.users, icon: Users, detail: summary ? number(summary.admins) + " with admin access" : "Registered accounts" },
    { section: "collections" as const, name: "Collections", value: summary?.collections, icon: Folder, detail: "Across all accounts" },
    { section: "pages" as const, name: "Tracked pages", value: summary?.pages, icon: FileStack, detail: "Page records across all accounts" },
  ];

  return <div className="adm-app">
    <aside className="adm-sidebar">
      <a className="adm-brand" href="/dashboard"><span><Layers3 size={23} /></span><div>Distribution<br />Desk<span>.</span></div></a>
      <div className="adm-access"><ShieldCheck size={17} /><span>Admin workspace<small>All registered workspaces</small></span></div>
      <div className="adm-nav-label">WORKSPACE DIRECTORY</div>
      <nav aria-label="Admin sections">{sections.map(key => {
        const Icon = key === "pages" ? FileStack : key === "collections" ? Folder : Users;
        return <button key={key} className={section === key ? "active" : ""} onClick={() => chooseSection(key)} aria-current={section === key ? "page" : undefined}><Icon size={18} /><span>{labels[key]}</span><small>{number(key === "pages" ? summary?.pages : key === "collections" ? summary?.collections : summary?.users)}</small></button>;
      })}<a href="/admin/providers" className="adm-provider-link"><ShieldCheck size={18}/><span>Providers &amp; refresh</span></a></nav>
      <div className="adm-sidebar-bottom"><a href="/dashboard"><ArrowLeft size={16} />My workspace</a><SignOutButton className="adm-signout"><LogOut size={16} />Sign out</SignOutButton><div className="adm-profile"><span>{initials(displayName)}</span><div><strong>{displayName}</strong><small>{account.email}</small></div></div></div>
    </aside>
    <main className="adm-main">
      <header className="adm-topbar"><div>Administration<span>/</span><strong>{labels[section]}</strong></div><a href="/admin/providers" className="adm-button"><ShieldCheck size={13} />Data sources</a></header>
      <div className="adm-content">
        <div className="adm-heading"><div><span className="adm-eyebrow">ALL ACCOUNTS, ONE DIRECTORY</span><h1>Workspace directory<span>.</span></h1><p>Find a person, open their collections, and inspect the pages they track.</p></div><a href="/dashboard" className="adm-button">My workspace<ArrowUpRight size={15} /></a></div>
        <div className="adm-stats">{cards.map(item => <button className="adm-stat" key={item.name} onClick={() => chooseSection(item.section)} aria-label={"Browse all " + labels[item.section].toLowerCase()}><div><span>{item.name}</span><item.icon size={19} /></div><strong>{number(item.value)}</strong><small>{item.detail}</small></button>)}</div>
        <section className="adm-panel" aria-label={labels[section] + " directory"} aria-busy={loading}>
          <div className="adm-panel-heading"><div><h2>{labels[section]}</h2><span aria-label={scoped ? "Matching records" : "Total records"}>{loading ? "…" : number(result?.total)}</span>{scoped && <small>matching</small>}</div><button className="adm-button" disabled={loading} onClick={() => setRevision(value => value + 1)} title="Reload saved directory records"><RefreshCw size={15} className={loading ? "spin" : ""} />Reload</button></div>
          <div className="adm-mobile-tabs" aria-label="Admin sections">{sections.map(key => <button key={key} className={section === key ? "active" : ""} aria-pressed={section === key} onClick={() => chooseSection(key)}>{labels[key]}</button>)}</div>
          {ownerFilter && <div className="adm-owner-context">
            <nav aria-label="Directory path"><ol>
              <li><button onClick={() => chooseSection("users")}>People</button></li>
              <li><ChevronRight size={13} aria-hidden="true" /><button onClick={() => chooseOwnerSection("collections")}>{ownerFilter.label}</button></li>
              <li><ChevronRight size={13} aria-hidden="true" />{collectionFilter ? <><button onClick={() => chooseOwnerSection("collections")}>Collections</button><ChevronRight size={13} aria-hidden="true" /><span aria-current="page">{collectionFilter.label}</span></> : <span aria-current="page">{labels[section]}</span>}</li>
            </ol></nav>
            <div className="adm-context-heading"><div><strong>{ownerFilter.label}</strong>{ownerFilter.email && ownerFilter.email !== ownerFilter.label && <span>{ownerFilter.email}</span>}<small>Account ID: {ownerFilter.id}</small></div><button className="adm-clear" aria-label="All accounts: clear account filter" onClick={() => chooseSection(section)}><X size={14} />All accounts</button></div>
            <AdminRecordActions ownerId={ownerFilter.id} label={ownerFilter.label} onDone={() => setRevision(value => value + 1)} />
            <div className="adm-context-tabs" aria-label="Selected account records"><button className={section === "collections" ? "active" : ""} aria-pressed={section === "collections"} onClick={() => chooseOwnerSection("collections")}><Folder size={14} />Collections</button><button className={section === "pages" && !collectionFilter ? "active" : ""} aria-pressed={section === "pages" && !collectionFilter} onClick={() => chooseOwnerSection("pages")}><FileStack size={14} />All pages</button>{collectionFilter && <span>Pages in <strong>{collectionFilter.label}</strong></span>}</div>
          </div>}
          <form className="adm-toolbar" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setOffset(0); }}>
            <label className="adm-search"><Search size={17} /><input aria-label={"Search " + labels[section].toLowerCase()} placeholder={section === "users" ? "Search by name, email, or account ID" : section === "collections" ? "Search collections or owner" : "Search pages, handles, or owner"} value={query} onChange={event => setQuery(event.target.value)} maxLength={200} /></label>
            <button className="adm-button" type="submit">Search</button>{search && <button type="button" className="adm-clear" onClick={resetSearch}>Clear search<X size={13} /></button>}
          </form>
          {error ? <div className="adm-error" role="alert"><AlertCircle size={21} /><div><strong>Could not load records</strong><p>{error}</p><button className="adm-button" onClick={() => setRevision(value => value + 1)}>Try again</button></div></div>
            : loading ? <div className="adm-loading" role="status"><Loader2 size={23} className="spin" />Loading {labels[section].toLowerCase()}…</div>
            : !items.length ? <div className="adm-empty"><Folder size={30} /><h3>{search ? "No matching records" : "No " + labels[section].toLowerCase() + " here yet"}</h3><p>{search ? "Try another name, handle, or email address." : collectionFilter ? "This collection has no saved pages." : ownerFilter ? "This account has not added " + labels[section].toLowerCase() + " here." : "Records appear here when people use their workspace."}</p>{search && <button className="adm-button" onClick={resetSearch}>Clear search</button>}</div>
            : <div className="adm-table-scroll" role="region" aria-label={labels[section] + " records"} tabIndex={0}>
              {section === "pages" ? <table className="adm-table adm-pages-table"><thead><tr><th scope="col">Page</th><th scope="col">Account</th><th scope="col" className="adm-numeric">Followers</th><th scope="col" className="adm-numeric">Selected views</th><th scope="col" className="adm-numeric">Saved posts</th><th scope="col">Saved selection</th><th scope="col">Last refresh</th><th scope="col" aria-label="Open page" /></tr></thead><tbody>{(items as PageRow[]).map(renderPage)}</tbody></table>
                : section === "collections" ? <table className="adm-table"><thead><tr><th scope="col">Collection</th><th scope="col">Account</th><th scope="col" className="adm-numeric">Pages</th><th scope="col">Created</th><th scope="col" className="adm-desktop-actions">Browse</th></tr></thead><tbody>{(items as CollectionRow[]).map(row => <tr key={row.id}>
                  <th scope="row"><button className="adm-collection-name" onClick={() => inspectCollection(row)} aria-label={"Open collection " + row.name}><span><Folder size={18} /></span><strong>{row.name}</strong></button></th><td>{renderOwner(row)}</td><td className="adm-numeric">{number(row.pageCount)}</td><td>{date(row.createdAt)}</td><td className="adm-desktop-actions"><button className="adm-row-link" onClick={() => inspectCollection(row)} aria-label={"Pages in " + row.name}>Pages<ChevronRight size={14} /></button></td>
                </tr>)}</tbody></table>
                  : <table className="adm-table"><thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col" className="adm-numeric">Collections</th><th scope="col" className="adm-numeric">Pages</th><th scope="col">Joined</th><th scope="col">Last active</th><th scope="col" className="adm-desktop-actions">Browse</th></tr></thead><tbody>{(items as UserRow[]).map(row => <tr key={row.id}>
                    <th scope="row"><div className="adm-page-name"><span>{initials(row.name || row.email || "U")}</span><div><strong>{row.name || row.email || "Unnamed account"}</strong>{row.email && <small>{row.email}</small>}<small className="adm-id" title={row.id}>{row.id}</small><div className="adm-mobile-row-actions"><button className="adm-row-link" onClick={() => inspectOwner(row)} aria-label={"Collections for " + (row.name || row.email || row.id)}>Collections<ChevronRight size={13} /></button><button className="adm-row-link" onClick={() => inspectOwner(row, "pages")} aria-label={"Pages for " + (row.name || row.email || row.id)}>Pages<ChevronRight size={13} /></button></div></div></div></th>
                    <td><span className={"adm-role " + (row.userType === "admin" ? "adm-role-admin" : "")}>{row.userType === "admin" && <ShieldCheck size={12} />}{row.userType === "admin" ? "Admin" : "User"}</span></td>
                    <td className="adm-numeric">{number(row.collectionCount)}</td><td className="adm-numeric">{number(row.pageCount)}</td><td>{date(row.createdAt)}</td><td title={date(row.lastSeenAt, true)}>{date(row.lastSeenAt)}</td>
                    <td className="adm-desktop-actions"><div className="adm-row-actions"><button className="adm-row-link" onClick={() => inspectOwner(row)} aria-label={"Collections for " + (row.name || row.email || row.id)}>Collections<ChevronRight size={14} /></button><button className="adm-row-link" onClick={() => inspectOwner(row, "pages")} aria-label={"Pages for " + (row.name || row.email || row.id)}>Pages<ChevronRight size={14} /></button></div></td>
                  </tr>)}</tbody></table>}
            </div>}
          {!loading && !error && result && <div className="adm-pagination"><span role="status">{items.length ? number(result.offset + 1) + "–" + number(result.offset + items.length) + " of " + number(result.total) : "0 records"}{scoped ? " in this view" : " total"}</span><div><button className="adm-button" disabled={result.offset === 0} onClick={() => setOffset(Math.max(0, result.offset - result.limit))}><ChevronLeft size={15} />Previous</button><button className="adm-button" disabled={!result.hasMore} onClick={() => setOffset(result.offset + result.limit)}>Next<ChevronRight size={15} /></button></div></div>}
        </section>
        <div className="adm-note"><Check size={15} /><p>This directory shows saved records. Each account keeps its own workspace; page metrics update when their owner refreshes them.</p></div>
        <footer className="adm-footer"><strong>Distribution Desk<span>.</span></strong><span>Workspace directory · Admin access</span></footer>
      </div>
    </main>
  </div>;
}
