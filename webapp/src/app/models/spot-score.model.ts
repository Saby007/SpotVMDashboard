export interface SpotScore {
  region: string;
  availabilityZone: string;
  sku: string;
  score: 'High' | 'Medium' | 'Low' | 'RestrictedSkuNotAvailable';
  isQuotaAvailable: boolean;
  evictionRate: string;
}

export interface QuotaInfo {
  apiName?: string;
  used: number;
  max: number;
  remaining: number;
  percentRemaining: number;
  resetsInSec: number;
}

export interface VmQuotaInfo {
  region: string;
  currentValue: number;
  limit: number;
  percentUsed: number;
  percentRemaining: number;
  unit: string;
  label: string;
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
