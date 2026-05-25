export interface SpotScore {
  region: string;
  availabilityZone: string;
  sku: string;
  score: 'High' | 'Medium' | 'Low' | 'RestrictedSkuNotAvailable';
  isQuotaAvailable: boolean;
  evictionRate: string;
}

export interface ScoreResponse {
  scores: SpotScore[];
  errors: { batch: string[]; status: number; message: string }[];
  timestamp: string;
}

export interface DashboardConfig {
  subscriptions: { id: string; name: string }[];
  regions: string[];
  skuFamilies: Record<string, string[]>;
  defaultDesiredCount: number;
}
