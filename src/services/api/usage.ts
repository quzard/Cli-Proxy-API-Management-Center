/**
 * 使用统计相关 API
 */

import { apiClient } from './client';
import {
  computeKeyStats,
  type KeyStats,
  type ModelPrice,
  type SharedModelPricesPayload
} from '@/utils/usage';

const USAGE_TIMEOUT_MS = 60 * 1000;

export interface UsageExportPayload {
  version?: number;
  exported_at?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface UsageImportResponse {
  added?: number;
  skipped?: number;
  total_requests?: number;
  failed_requests?: number;
  [key: string]: unknown;
}

export interface UsageModelPricesResponse {
  'usage-model-prices'?: Record<string, ModelPrice>;
  usageModelPrices?: Record<string, ModelPrice>;
  'disabled-default-models'?: string[];
  disabledDefaultModels?: string[];
  [key: string]: unknown;
}

export interface UsagePeriodSummaryWindow {
  id: string;
  auth_index?: string;
  authIndex?: string;
  start_at_ms?: number;
  startAtMs?: number;
  end_at_ms?: number;
  endAtMs?: number;
  model_filter?: string | null;
  modelFilter?: string | null;
}

export interface UsagePeriodSummaryRequest {
  windows: UsagePeriodSummaryWindow[];
  model_prices?: Record<string, ModelPrice>;
  modelPrices?: Record<string, ModelPrice>;
}

export interface UsagePeriodSummaryItem {
  id: string;
  requests: number;
  tokens: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cost: number;
}

export interface UsagePeriodSummaryResponse {
  items?: UsagePeriodSummaryItem[];
  generated_at?: string;
  [key: string]: unknown;
}

export const usageApi = {
  /**
   * 获取使用统计原始数据
   */
  getUsage: () => apiClient.get<Record<string, unknown>>('/usage', { timeout: USAGE_TIMEOUT_MS }),

  /**
   * 按时间窗口获取聚合后的使用统计
   */
  getUsagePeriodSummary: (payload: UsagePeriodSummaryRequest) =>
    apiClient.post<UsagePeriodSummaryResponse>('/usage/period-summary', payload, {
      timeout: USAGE_TIMEOUT_MS
    }),

  /**
   * 导出使用统计快照
   */
  exportUsage: () => apiClient.get<UsageExportPayload>('/usage/export', { timeout: USAGE_TIMEOUT_MS }),

  /**
   * 导入使用统计快照
   */
  importUsage: (payload: unknown) =>
    apiClient.post<UsageImportResponse>('/usage/import', payload, { timeout: USAGE_TIMEOUT_MS }),

  /**
   * 获取共享模型价格
   */
  async getUsageModelPrices(): Promise<SharedModelPricesPayload> {
    const data = await apiClient.get<UsageModelPricesResponse>('/usage-model-prices', {
      timeout: USAGE_TIMEOUT_MS
    });
    return {
      prices: (data?.['usage-model-prices'] ?? data?.usageModelPrices ?? {}) as Record<string, ModelPrice>,
      disabledDefaultModels: Array.isArray(data?.['disabled-default-models'])
        ? (data?.['disabled-default-models'] as string[])
        : Array.isArray(data?.disabledDefaultModels)
          ? (data?.disabledDefaultModels as string[])
          : []
    };
  },

  /**
   * 更新共享模型价格
   */
  updateUsageModelPrices: (payload: SharedModelPricesPayload) =>
    apiClient.put(
      '/usage-model-prices',
      {
        value: payload.prices,
        disabledDefaultModels: payload.disabledDefaultModels
      },
      { timeout: USAGE_TIMEOUT_MS }
    ),

  /**
   * 计算密钥成功/失败统计，必要时会先获取 usage 数据
   */
  async getKeyStats(usageData?: unknown): Promise<KeyStats> {
    let payload = usageData;
    if (!payload) {
      const response = await apiClient.get<Record<string, unknown>>('/usage', { timeout: USAGE_TIMEOUT_MS });
      payload = response?.usage ?? response;
    }
    return computeKeyStats(payload);
  }
};
