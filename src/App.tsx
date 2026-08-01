import { FormEvent, useCallback, useEffect, useState } from "react";
import type {
  AdminStatus,
  ArticleResult,
  OccurrenceResult,
  SearchResponse,
  SessionUser,
} from "../shared/api";

interface SessionResponse {
  authenticated: boolean;
  user?: SessionUser;
}

export default function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadResults = useCallback(async (search: string, cursor?: string, append = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (cursor) params.set("cursor", cursor);
      const response = await api<SearchResponse>(`/api/search?${params}`);
      setResults((current) => append && current
        ? { items: [...current.items, ...response.items], nextCursor: response.nextCursor }
        : response);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api<SessionResponse>("/api/session")
      .then((value) => {
        setSession(value);
        if (value.authenticated) void loadResults("");
      })
      .catch((caught) => {
        setSession({ authenticated: false });
        setError(errorMessage(caught));
      });
  }, [loadResults]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const cleaned = query.trim();
    setSubmittedQuery(cleaned);
    void loadResults(cleaned);
  }

  async function logout() {
    await fetch("/auth/logout", { method: "POST" });
    setSession({ authenticated: false });
    setResults(null);
  }

  if (!session) return <LoadingScreen />;
  if (!session.authenticated || !session.user) {
    return <LoginScreen error={new URLSearchParams(location.search).get("login_error") || error} />;
  }

  return (
    <div className="page-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Milton home">
          <span className="brand-mark">M</span>
          <span>
            <strong>Milton</strong>
            <small>the shared-link index</small>
          </span>
        </a>
        <div className="identity">
          {session.user.avatarUrl
            ? <img src={session.user.avatarUrl} alt="" />
            : <span className="avatar-fallback">{session.user.displayName.slice(0, 1)}</span>}
          <span>{session.user.displayName}</span>
          <button className="text-button" onClick={() => void logout()}>Log out</button>
        </div>
      </header>

      <main>
        <section className="search-hero">
          <p className="eyebrow">Your Discord, remembered</p>
          <h1>Find the thing someone shared.</h1>
          <form className="search-form" onSubmit={submitSearch}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.35-4.35m2.35-5.65a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" /></svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search titles and article text"
              aria-label="Search shared links"
              autoFocus
            />
            <button type="submit">Search</button>
          </form>
        </section>

        <section className="results-section">
          <div className="section-heading">
            <h2>{submittedQuery ? `Results for “${submittedQuery}”` : "Recently shared"}</h2>
            {results && <span>{results.items.length}{results.nextCursor ? "+" : ""} links</span>}
          </div>
          {error && <div className="notice error">{error}</div>}
          {!results && loading && <ResultSkeletons />}
          {results?.items.length === 0 && !loading && (
            <div className="empty-state">
              <span>⌕</span>
              <h3>No links found</h3>
              <p>Try fewer words or a different spelling.</p>
            </div>
          )}
          <div className="result-list">
            {results?.items.map((result) => <ResultCard key={result.id} result={result} />)}
          </div>
          {results?.nextCursor && (
            <button
              className="load-more"
              disabled={loading}
              onClick={() => void loadResults(submittedQuery, results.nextCursor!, true)}
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          )}
        </section>

        {session.user.isAdmin && <AdminPanel />}
      </main>

      <footer>Indexed from Discord · Search stays inside the community</footer>
    </div>
  );
}

function ResultCard({ result }: { result: ArticleResult }) {
  const [expanded, setExpanded] = useState(false);
  const [occurrences, setOccurrences] = useState<OccurrenceResult[]>([result.latestOccurrence]);
  const [loading, setLoading] = useState(false);

  async function toggleOccurrences() {
    const next = !expanded;
    setExpanded(next);
    if (!next || occurrences.length >= result.occurrenceCount) return;
    setLoading(true);
    try {
      const response = await api<{ items: OccurrenceResult[] }>(`/api/articles/${result.id}/occurrences`);
      setOccurrences(response.items);
    } finally {
      setLoading(false);
    }
  }

  return (
    <article className="result-card">
      <div className="domain-line">
        <span className="domain-icon">{result.domain.slice(0, 1).toUpperCase()}</span>
        <span>{result.domain}</span>
        <span className={`status ${result.extractionStatus}`}>{statusLabel(result.extractionStatus)}</span>
      </div>
      <h3><a href={result.url} target="_blank" rel="noreferrer">{result.title}</a></h3>
      {result.excerpt && <p className="excerpt">{result.excerpt}</p>}
      <div className="result-actions">
        <a className="article-link" href={result.url} target="_blank" rel="noreferrer">Read article ↗</a>
        <a className="discussion-link" href={result.latestOccurrence.messageUrl} target="_blank" rel="noreferrer">
          Open discussion ↗
        </a>
        {result.occurrenceCount > 1 && (
          <button className="text-button" onClick={() => void toggleOccurrences()}>
            {expanded ? "Hide" : `View all ${result.occurrenceCount} shares`}
          </button>
        )}
      </div>
      <p className="shared-by">
        Shared by {result.latestOccurrence.authorName} in #{result.latestOccurrence.channelName} · {relativeDate(result.latestOccurrence.postedAt)}
      </p>
      {expanded && (
        <div className="occurrences">
          {loading ? <span>Loading discussions…</span> : occurrences.map((occurrence) => (
            <a key={occurrence.id} href={occurrence.messageUrl} target="_blank" rel="noreferrer">
              <strong>#{occurrence.channelName}</strong>
              <span>{occurrence.authorName} · {relativeDate(occurrence.postedAt)}</span>
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function AdminPanel() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<AdminStatus>("/api/admin/status").then(setStatus).catch((caught) => setError(errorMessage(caught)));
  }, []);
  useEffect(refresh, [refresh]);

  async function startBackfill() {
    await api("/api/admin/backfill", { method: "POST" });
    refresh();
  }

  return (
    <section className="admin-panel">
      <div className="section-heading">
        <div><p className="eyebrow">Administrator</p><h2>Indexer status</h2></div>
        <button className="text-button" onClick={refresh}>Refresh</button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {status && (
        <>
          <div className="metric-grid">
            <Metric label="D1 storage" value={`${formatBytes(status.databaseBytes)} / ${formatBytes(status.databaseLimitBytes)}`} warning={status.databaseWarning} />
            <Metric label="Browser today" value={`${formatDuration(status.browserMillisecondsToday)} / ${formatDuration(status.browserDailyLimitMilliseconds)}`} />
            <Metric label="Live jobs" value={String(status.pendingLiveJobs)} />
            <Metric label="Historical jobs" value={String(status.pendingBackfillJobs)} />
            <Metric label="Channels complete" value={`${status.channelsComplete} / ${status.channelsTotal}`} />
            <Metric label="Failed jobs" value={String(status.failedJobs)} warning={status.failedJobs > 0} />
          </div>
          {status.backfillPausedReason && <div className="notice">{status.backfillPausedReason}</div>}
          {!status.backfillEnabled && <button className="primary-button" onClick={() => void startBackfill()}>Start historical backfill</button>}
        </>
      )}
    </section>
  );
}

function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <div className={`metric ${warning ? "warning" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function LoginScreen({ error }: { error: string | null }) {
  return (
    <main className="login-screen">
      <div className="login-card">
        <span className="large-mark">M</span>
        <p className="eyebrow">The shared-link index</p>
        <h1>Your community has excellent taste. Find it again.</h1>
        <p>Milton quietly indexes articles shared in Discord, then connects every result back to the conversation where it appeared.</p>
        {error && <div className="notice error">{error}</div>}
        <a className="discord-button" href="/auth/discord">
          <span aria-hidden="true">◖◗</span> Continue with Discord
        </a>
        <small>Access is limited to current server members.</small>
      </div>
    </main>
  );
}

function LoadingScreen() {
  return <main className="loading-screen"><span className="large-mark pulse">M</span></main>;
}

function ResultSkeletons() {
  return <div className="result-list">{[0, 1, 2].map((item) => <div className="result-card skeleton" key={item} />)}</div>;
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string; error?: string } | null;
    throw new Error(payload?.message || payload?.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function statusLabel(status: ArticleResult["extractionStatus"]): string {
  if (status === "indexed") return "Full text";
  if (status === "pending") return "Indexing";
  return "Link only";
}

function relativeDate(value: string): string {
  const timestamp = new Date(value).getTime();
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Date(value).toLocaleDateString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
