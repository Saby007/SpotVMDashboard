export type PlacementScore = 'High' | 'Medium' | 'Low' | 'RestrictedSkuNotAvailable' | 'DataNotFoundOrStale' | 'Unknown';
export type EvictionRate = '0-5' | '5-10' | '10-15' | '15-20' | '20+';

export interface SpotScore {
  region: string;
  availabilityZone: string;
  sku: string;
  score: PlacementScore;
  scoreDetail: string | null;
  isQuotaAvailable: boolean | null;
  evictionRate: EvictionRate | null;
}

export interface PlacementScoreResponse {
  placementScores: Omit<SpotScore, 'evictionRate'>[];
  warnings: string[];
  fetchedAt: string;
}

export interface EvictionRatesResponse {
  rates: Record<string, EvictionRate | null>;
  fetchedAt: string;
}

export interface VmQuotaInfo {
  region: string;
  currentValue: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  percentRemaining: number;
  unit: string;
  label: string;
  fetchedAt: string;
}

export interface ScoreResponse {
  scores: SpotScore[];
  errors: { batch: string[]; status: number; message: string }[];
  timestamp: string;
}

export interface DashboardConfig {
  regions: string[];
  skuFamilies: Record<string, string[]>;
  defaultDesiredCount: number;
  catalogSource: 'azure' | 'static';
  catalogRegion: string;
  catalogFetchedAt: string | null;
  warnings: string[];
}

export interface Subscription {
  id: string;
  name: string;
}

export interface UserInfo {
  oid: string;
  name: string;
  upn: string;
}
