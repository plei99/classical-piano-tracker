export interface StatsResponse {
  total_listens: number;
  total_performances: number;
  composers_tracked: number;
  total_minutes: number;
}

export interface PerformanceSummary {
  id: number;
  composer: string;
  work_title: string;
  pianist: string;
  album_name: string;
  spotify_track_name: string;
  source_confidence: number;
  listen_count: number;
  total_minutes: number;
  last_heard_at: string | null;
}

export interface ListeningEventRead {
  id: number;
  listened_at: string;
  ms_played: number;
  platform: string;
  track_name: string;
  artist_name: string;
  album_name: string;
  performance_id: number;
  composer: string;
  work_title: string;
  pianist: string;
}

export interface DashboardResponse {
  stats: StatsResponse;
  top_performances: PerformanceSummary[];
  recent_listens: ListeningEventRead[];
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

export async function getDashboard(): Promise<DashboardResponse> {
  const response = await fetch(`${API_BASE_URL}/api/dashboard`);
  if (!response.ok) {
    throw new Error(`Dashboard request failed with ${response.status}`);
  }
  return response.json() as Promise<DashboardResponse>;
}

