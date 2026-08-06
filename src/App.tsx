import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type {
  AdminStatus,
  ArticleResult,
  FailedJobResult,
  SearchResponse,
  SessionUser,
} from "../shared/api";

interface SessionResponse {
  authenticated: boolean;
  user?: SessionUser;
}

/** `search` replaces the visible results; `more` appends the next page to them. */
type Pending = null | "search" | "more";

export default function App() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdminPage = /^\/admin\/?$/.test(location.pathname);

  // Identifies the newest request so a slow "load more" cannot append its page
  // onto the results of a search submitted after it.
  const latestRequest = useRef(0);

  const loadResults = useCallback(async (search: string, cursor?: string) => {
    const request = (latestRequest.current += 1);
    setPending(cursor ? "more" : "search");
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (cursor) params.set("cursor", cursor);
      const response = await api<SearchResponse>(`/api/search?${params}`);
      if (request !== latestRequest.current) return;
      setResults((current) => (cursor && current
        ? { items: [...current.items, ...response.items], nextCursor: response.nextCursor }
        : response));
    } catch (caught) {
      if (request !== latestRequest.current) return;
      // An expired session belongs on the login screen, not in an error banner.
      if (caught instanceof ApiError && caught.status === 401) setSession({ authenticated: false });
      else setError(errorMessage(caught));
    } finally {
      if (request === latestRequest.current) setPending(null);
    }
  }, []);

  useEffect(() => {
    api<SessionResponse>("/api/session")
      .then((value) => {
        setSession(value);
        if (value.authenticated && !isAdminPage) void loadResults("");
      })
      .catch((caught) => {
        setSession({ authenticated: false });
        setError(errorMessage(caught));
      });
  }, [isAdminPage, loadResults]);

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

  if (isAdminPage) {
    return (
      <div className="page-shell">
        <SiteHeader user={session.user} currentPage="admin" onLogout={logout} />
        <main className="admin-page">
          {session.user.isAdmin
            ? <AdminPanel />
            : <div className="notice error">You do not have access to this page.</div>}
        </main>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <SiteHeader user={session.user} currentPage="home" onLogout={logout} />

      <main>
        <section className="search-hero">
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
            {results && pending !== "search" && <span>{results.items.length} links</span>}
          </div>
          {error && <div className="notice error">{error}</div>}
          {pending === "search" ? <ResultSkeletons /> : (
            <div className="result-list">
              {results?.items.map((result) => <ResultCard key={result.id} result={result} />)}
            </div>
          )}
          {results?.items.length === 0 && !pending && (
            <div className="empty-state">
              <span>⌕</span>
              <h3>No links found</h3>
            </div>
          )}
          {results?.nextCursor && pending !== "search" && (
            <button
              className="load-more"
              disabled={pending === "more"}
              onClick={() => void loadResults(submittedQuery, results.nextCursor!)}
            >
              {pending === "more" ? "Loading…" : "Load more"}
            </button>
          )}
        </section>
      </main>

    </div>
  );
}

function SiteHeader({
  user,
  currentPage,
  onLogout,
}: {
  user: SessionUser;
  currentPage: "home" | "admin";
  onLogout: () => Promise<void>;
}) {
  return (
    <header className="site-header">
      <a className="brand" href="/">Milton</a>
      <div className="header-actions">
        {user.isAdmin && (
          <a
            className="header-link"
            href="/admin"
            aria-current={currentPage === "admin" ? "page" : undefined}
          >
            Admin
          </a>
        )}
        <div className="identity">
          {user.avatarUrl
            ? <img src={user.avatarUrl} alt="" />
            : <span className="avatar-fallback">{user.displayName.slice(0, 1)}</span>}
          <span>{user.displayName}</span>
          <button className="text-button" onClick={() => void onLogout()}>Log out</button>
        </div>
      </div>
    </header>
  );
}

function ResultCard({ result }: { result: ArticleResult }) {
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
        <a className="discussion-link" href={result.latestOccurrence.messageUrl} target="_blank" rel="noreferrer">
          Discussion ↗
        </a>
        <span className="shared-by">
          {result.latestOccurrence.authorName} · #{result.latestOccurrence.channelName} · {relativeDate(result.latestOccurrence.postedAt)}
        </span>
      </div>
    </article>
  );
}

function AdminPanel() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [failedJobs, setFailedJobs] = useState<FailedJobResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [nextStatus, nextFailedJobs] = await Promise.all([
        api<AdminStatus>("/api/admin/status"),
        api<FailedJobResult[]>("/api/admin/failed-jobs"),
      ]);
      setStatus(nextStatus);
      setFailedJobs(nextFailedJobs);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function act(path: string) {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: "POST" });
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-panel">
      <div className="section-heading">
        <h2>Indexer status</h2>
        <button className="text-button" onClick={() => void refresh()}>Refresh</button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {status && (
        <>
          <div className="metric-grid">
            <Metric label="Extractor" value="HTTP + Readability" />
            <Metric label="Live jobs" value={String(status.pendingLiveJobs)} />
            <Metric label="Historical jobs" value={String(status.pendingBackfillJobs)} />
            <Metric label="Channels complete" value={`${status.channelsComplete} / ${status.channelsTotal}`} />
            <Metric label="Failed jobs" value={String(status.failedJobs)} warning={status.failedJobs > 0} />
          </div>
          {!status.backfillEnabled && (
            <>
              <div className="notice">Backfill has not been started.</div>
              <button className="primary-button" disabled={busy} onClick={() => void act("/api/admin/backfill")}>
                Start historical backfill
              </button>
            </>
          )}
          {status.failedJobs > 0 && (
            <>
              <div className="failed-jobs-heading">
                <h3>Failed extractions</h3>
                <span>{failedJobs?.length ?? 0} shown</span>
              </div>
              <div className="failed-job-list">
                {failedJobs?.map((job) => <FailedJob key={job.articleId} job={job} />)}
              </div>
              <button className="primary-button" disabled={busy} onClick={() => void act("/api/admin/retry-failed")}>
                {busy ? "Requeueing…" : "Retry failed extractions"}
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}

function FailedJob({ job }: { job: FailedJobResult }) {
  return (
    <article className="failed-job">
      <div className="failed-job-title">
        {job.url
          ? <a href={job.url} target="_blank" rel="noreferrer">{job.title}</a>
          : <span>{job.title}</span>}
        <span>{relativeDate(job.failedAt)}</span>
      </div>
      <p>{job.reason}</p>
      <div className="failed-job-meta">
        {job.failureClass && <span>{job.failureClass.replaceAll("_", " ")}</span>}
        {job.httpStatus !== null && <span>HTTP {job.httpStatus}</span>}
        <span>{job.attempts} {job.attempts === 1 ? "attempt" : "attempts"}</span>
        <span>{job.priority === "live" ? "Live" : "Historical"}</span>
        {job.domain && <span>{job.domain}</span>}
      </div>
    </article>
  );
}

function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <div className={`metric ${warning ? "warning" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}

function LoginScreen({ error }: { error: string | null }) {
  return (
    <main className="login-screen">
      <span className="screen-brand">Milton</span>
      <div className="login-card">
        {error && <div className="notice error">{error}</div>}
        <a className="discord-button" href="/auth/discord">
          <span aria-hidden="true">◖◗</span> Continue with Discord
        </a>
      </div>
    </main>
  );
}

function LoadingScreen() {
  return <main className="loading-screen"><span className="screen-brand pulse">Milton</span></main>;
}

function ResultSkeletons() {
  return <div className="result-list">{[0, 1, 2].map((item) => <div className="result-card skeleton" key={item} />)}</div>;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string; error?: string } | null;
    throw new ApiError(response.status, payload?.message || payload?.error || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function statusLabel(status: ArticleResult["extractionStatus"]): string {
  if (status === "indexed") return "Indexed";
  if (status === "pending") return "Indexing";
  return "Link only";
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number, number]> = [
  ["second", 1, 60],
  ["minute", 60, 60],
  ["hour", 3600, 24],
  ["day", 86_400, 30],
];
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function relativeDate(value: string): string {
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  for (const [unit, size, limit] of RELATIVE_UNITS) {
    const amount = Math.round(seconds / size);
    if (Math.abs(amount) < limit) return relativeFormat.format(amount, unit);
  }
  return new Date(value).toLocaleDateString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
