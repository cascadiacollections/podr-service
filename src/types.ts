/**
 * Canonical media shape consumed by the Android client via UniFFI → Kotlin.
 *
 * All endpoints that return playable content normalize to this shape directly;
 * we do not maintain a separate internal representation.
 */
export type MediaType = 'Stream' | 'Podcast' | 'LocalFile';

export interface MediaItem {
  uri: string;
  title?: string;
  artist?: string;
  artwork_url?: string;
  media_type: MediaType;
}

export interface FeedResponse {
  title?: string;
  artwork_url?: string;
  episodes: MediaItem[];
}

export interface HistoryRow {
  uri: string;
  title: string | null;
  last_played: number;
  count: number;
}

export interface SubscriptionRow {
  uri: string;
  title: string | null;
  artwork_url: string | null;
  added_at: number;
}
