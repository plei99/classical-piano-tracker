import { useEffect, useState } from "react";

import { StatCard } from "./components/StatCard";
import { DashboardResponse, getDashboard, getSpotifyConnectUrl } from "./lib/api";

const statAccents = ["#a86d1d", "#1d4f4b", "#6d2e3b", "#3f6ea5"];

interface SpotifyBannerState {
  tone: "success" | "error";
  message: string;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "Not heard yet";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatMinutes(value: number): string {
  return `${value.toFixed(1)} min`;
}

export default function App() {
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spotifyBanner, setSpotifyBanner] = useState<SpotifyBannerState | null>(null);

  async function loadDashboard() {
    setLoading(true);
    setError(null);

    try {
      const data = await getDashboard();
      setDashboard(data);
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : "Unknown error while loading the dashboard.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    const spotifyState = currentUrl.searchParams.get("spotify");
    if (spotifyState === "connected") {
      const importedCount = currentUrl.searchParams.get("imported") ?? "0";
      const skippedCount = currentUrl.searchParams.get("skipped") ?? "0";
      setSpotifyBanner({
        tone: "success",
        message: `Spotify connected. Imported ${importedCount} recent listens and skipped ${skippedCount} duplicates.`,
      });
    }

    if (spotifyState === "error") {
      const message =
        currentUrl.searchParams.get("message") ?? "Spotify connection failed.";
      setSpotifyBanner({
        tone: "error",
        message,
      });
    }

    if (spotifyState) {
      currentUrl.searchParams.delete("spotify");
      currentUrl.searchParams.delete("imported");
      currentUrl.searchParams.delete("skipped");
      currentUrl.searchParams.delete("message");
      window.history.replaceState({}, "", currentUrl.toString());
    }

    void loadDashboard();
  }, []);

  const stats = dashboard?.stats;
  const cards = stats
    ? [
        { label: "Listens", value: String(stats.total_listens) },
        { label: "Performances", value: String(stats.total_performances) },
        { label: "Composers", value: String(stats.composers_tracked) },
        { label: "Minutes", value: formatMinutes(stats.total_minutes) },
      ]
    : [];

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(168,109,29,0.18),_transparent_32%),linear-gradient(180deg,_#efe6d8_0%,_#f8f4ed_42%,_#ebe3d6_100%)] text-ink">
      <main className="mx-auto flex min-h-screen max-w-7xl flex-col px-6 py-8 sm:px-10 lg:px-12">
        <section className="relative overflow-hidden rounded-[2.5rem] border border-white/60 bg-white/70 px-6 py-10 shadow-panel backdrop-blur sm:px-10">
          <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-[radial-gradient(circle_at_center,_rgba(29,79,75,0.18),_transparent_60%)] lg:block" />
          <p className="text-xs uppercase tracking-[0.32em] text-ink/50">
            Personal listening archive
          </p>
          <div className="mt-5 flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <h1 className="font-display text-5xl leading-none text-ink sm:text-6xl">
                Track the piano performances you keep returning to.
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-ink/70">
                This starter app turns Spotify listening history into a personal ledger
                of pianists, works, and repeat listening patterns. The backend ships
                with seeded sample data so the dashboard has immediate shape.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                className="inline-flex items-center justify-center rounded-full bg-[#1db954] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#169c46]"
                onClick={() => {
                  window.location.assign(getSpotifyConnectUrl(window.location.href));
                }}
                type="button"
              >
                Connect to Spotify
              </button>
              <button
                className="inline-flex items-center justify-center rounded-full border border-ink/10 bg-ink px-5 py-3 text-sm font-semibold text-parchment transition hover:bg-claret"
                onClick={() => {
                  void loadDashboard();
                }}
                type="button"
              >
                Refresh dashboard
              </button>
            </div>
          </div>
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {loading && !dashboard
            ? Array.from({ length: 4 }).map((_, index) => (
                <div
                  className="h-36 animate-pulse rounded-[2rem] bg-white/60 shadow-panel"
                  key={index}
                />
              ))
            : cards.map((card, index) => (
                <StatCard
                  key={card.label}
                  label={card.label}
                  value={card.value}
                  accent={statAccents[index % statAccents.length]}
                />
              ))}
        </section>

        <section className="mt-8 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="rounded-[2rem] border border-white/60 bg-white/75 p-6 shadow-panel backdrop-blur sm:p-8">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-ink/50">
                  Top performances
                </p>
                <h2 className="mt-2 font-display text-3xl text-ink">
                  Most replayed recordings
                </h2>
              </div>
              {loading ? (
                <span className="text-sm text-ink/50">Loading…</span>
              ) : null}
            </div>

            <div className="mt-8 space-y-4">
              {dashboard?.top_performances.map((performance) => (
                <article
                  className="rounded-[1.5rem] border border-ink/10 bg-parchment/70 p-5"
                  key={performance.id}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm uppercase tracking-[0.22em] text-claret">
                        {performance.composer}
                      </p>
                      <h3 className="mt-2 font-display text-2xl leading-tight">
                        {performance.work_title}
                      </h3>
                      <p className="mt-2 text-sm text-ink/70">
                        {performance.pianist} · {performance.album_name}
                      </p>
                    </div>
                    <div className="rounded-2xl bg-white/80 px-4 py-3 text-sm text-ink/70">
                      <div>{performance.listen_count} listens</div>
                      <div>{formatMinutes(performance.total_minutes)}</div>
                    </div>
                  </div>
                  <p className="mt-4 text-sm text-ink/60">
                    Last heard {formatDateTime(performance.last_heard_at)}
                  </p>
                </article>
              ))}
            </div>
          </div>

          <div className="rounded-[2rem] border border-white/60 bg-white/75 p-6 shadow-panel backdrop-blur sm:p-8">
            <p className="text-xs uppercase tracking-[0.28em] text-ink/50">
              Recent listens
            </p>
            <h2 className="mt-2 font-display text-3xl text-ink">Listening log</h2>

            <div className="mt-8 space-y-4">
              {dashboard?.recent_listens.map((listen) => (
                <div
                  className="rounded-[1.5rem] border border-ink/10 bg-white/70 p-4"
                  key={listen.id}
                >
                  <p className="text-sm uppercase tracking-[0.22em] text-pine">
                    {listen.composer}
                  </p>
                  <p className="mt-1 font-semibold text-ink">{listen.work_title}</p>
                  <p className="mt-1 text-sm text-ink/70">
                    {listen.pianist} · {formatMinutes(listen.ms_played / 60000)}
                  </p>
                  <p className="mt-2 text-sm text-ink/60">
                    {formatDateTime(listen.listened_at)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {error ? (
          <div className="mt-6 rounded-2xl border border-claret/20 bg-claret/10 px-5 py-4 text-sm text-claret">
            Failed to load backend data: {error}
          </div>
        ) : null}

        {spotifyBanner ? (
          <div
            className={`mt-6 rounded-2xl px-5 py-4 text-sm ${
              spotifyBanner.tone === "success"
                ? "border border-pine/20 bg-pine/10 text-pine"
                : "border border-claret/20 bg-claret/10 text-claret"
            }`}
          >
            {spotifyBanner.message}
          </div>
        ) : null}
      </main>
    </div>
  );
}
