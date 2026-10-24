import { ArrowRight, Check, ChevronRight, Copy, FolderOpen, Layers3, Plus, Camera, Video, Music2, Sparkles } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import "./home.css";

export const dynamic = "force-dynamic";

export default async function LandingPage() {
  const user = await getCurrentUser();
  const destination = user ? "/dashboard" : "/login";
  return <div className="home-shell">
    <div className="home-wrap">
      <header className="home-nav">
        <a className="home-brand" href="/" aria-label="Distribution Desk home"><span className="home-brand-mark"><Layers3 size={23}/></span><span>Distribution Desk.</span></a>
        <nav className="home-nav-links" aria-label="Main navigation"><a href="#how-it-works">How it works</a><a className="home-button" href={destination}>{user ? "Open workspace" : "Sign in"}<ArrowRight size={14}/></a></nav>
      </header>
      <main>
        <section className="home-hero" aria-labelledby="home-title">
          <div>
            <div className="home-eyebrow"><span/>One creator. Every page.</div>
            <h1 className="home-title" id="home-title">Your pages.<br/>One <em>clearer</em><br/>picture.</h1>
            <p className="home-hero-description">Collect Instagram, YouTube, and TikTok pages in one place. Group them by creator or brand, and see their numbers together.</p>
            <div className="home-hero-actions"><a className="home-button home-button-primary" href={destination}>{user ? "Open your workspace" : "Get started"}<ArrowRight size={17}/></a><a className="home-button" href="#how-it-works">See how it works<ChevronRight size={15}/></a></div>
            <p className="home-small-note">Start with a collection. Add your pages. Connect a data source when ready.</p>
            <div className="home-platforms" aria-label="Supported platforms"><span><Camera/>Instagram</span><span><Video/>YouTube</span><span><Music2/>TikTok</span></div>
          </div>
          <div className="home-board" aria-label="Illustration of pages grouped into a collection">
            <div className="home-board-top"><span/>YOUR DISTRIBUTION DESK<Layers3 size={15}/></div>
            <div className="home-board-title"><FolderOpen size={23}/>One creator’s pages</div>
            <p className="home-board-caption">Different platforms. One collection.</p>
            <div className="home-board-row"><span className="home-board-icon instagram"><Camera size={17}/></span><span>Instagram pages<small>Fan pages &amp; community clips</small></span><Check size={15}/></div>
            <div className="home-board-row"><span className="home-board-icon youtube"><Video size={18}/></span><span>YouTube channels<small>Shorts &amp; video uploads</small></span><Check size={15}/></div>
            <div className="home-board-row"><span className="home-board-icon tiktok"><Music2 size={17}/></span><span>TikTok pages<small>Another part of the picture</small></span><Check size={15}/></div>
            <div className="home-board-summary"><div><span>FOLLOWERS</span><strong>Side by side</strong></div><div><span>VIEWS</span><strong>Combined</strong></div><div><span>POSTS</span><strong>Your scope</strong></div></div>
            <div className="home-board-label"><Sparkles size={13}/>LESS SWITCHING TABS. MORE CLARITY.</div>
          </div>
        </section>
        <section className="home-section" id="how-it-works" aria-labelledby="home-how-title">
          <div className="home-section-head"><h2 className="home-section-title" id="home-how-title">A small setup.<br/>A useful view.</h2><p>Build the groups that make sense to you. Keep the workflow simple, from adding pages to comparing collections.</p></div>
          <div className="home-steps">
            <article className="home-step"><span className="home-step-index">01</span><FolderOpen size={24}/><h3>Make a collection</h3><p>Name a group after a creator, brand, or community. Give every page a place.</p></article>
            <article className="home-step"><span className="home-step-index">02</span><Plus size={24}/><h3>Add your pages</h3><p>Paste public profile links, one or many. Connect a data source and refresh when you need current counts.</p></article>
            <article className="home-step"><span className="home-step-index">03</span><Copy size={24}/><h3>See them together</h3><p>View combined metrics, choose your post selection, or duplicate a collection to compare a smaller group.</p></article>
          </div>
        </section>
        <section className="home-bottom" aria-labelledby="home-start-title"><div><h2 id="home-start-title">Bring your first pages together.</h2><p>Choose a post count or publication date range. Available public metrics appear with coverage details, so you can see what the numbers include.</p></div><a className="home-button home-button-primary" href={destination}>{user ? "Open workspace" : "Create your workspace"}<ArrowRight size={17}/></a></section>
      </main>
      <footer className="home-footer"><span>Distribution Desk.</span><span>Public pages. Organised around your work.</span></footer>
    </div>
  </div>;
}
