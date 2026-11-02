import type { Platform } from '../../../shared/contracts';
import type { SourceKind } from './links';

export interface SourceRow {
  id: number;
  platform: Platform;
  kind: SourceKind;
  input_url: string;
  canonical_url: string | null;
  platform_id: string | null;
  name: string | null;
  method: 'api' | 'browser';
  depth_days: number | null;
  schedule_minutes: number | null;
  status: string;
  status_detail: string | null;
  paused: number;
  initial_crawl_done: number;
  last_run_started_at: string | null;
  last_run_finished_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}
