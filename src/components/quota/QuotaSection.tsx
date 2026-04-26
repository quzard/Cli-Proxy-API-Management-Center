/**
 * Generic quota section component.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usageApi } from '@/services/api';
import {
  USAGE_STATS_STALE_TIME_MS,
  useNotificationStore,
  useQuotaStore,
  useThemeStore,
  useUsageStatsStore
} from '@/stores';
import type { AuthFileItem, CodexQuotaWindow, ResolvedTheme } from '@/types';
import { getStatusFromError } from '@/utils/quota';
import {
  calculateCost,
  extractTotalTokens,
  getDefaultModelPrices,
  mergeModelPricesWithDefaults,
  normalizeAuthIndex,
  normalizeSharedModelPrices,
  type ModelPrice,
  type UsageDetail
} from '@/utils/usage';
import { QuotaCard } from './QuotaCard';
import type { QuotaPeriodSummary, QuotaStatusState, QuotaUsageContext } from './QuotaCard';
import { useQuotaLoader } from './useQuotaLoader';
import { getCodexPeriodSummaryKey, type QuotaConfig } from './quotaConfigs';
import { useGridColumns } from './useGridColumns';
import { IconRefreshCw } from '@/components/ui/icons';
import styles from '@/pages/QuotaPage.module.scss';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

type ViewMode = 'paged' | 'all';

const MAX_ITEMS_PER_PAGE = 25;
const MAX_SHOW_ALL_THRESHOLD = 30;
const DEFAULT_AUTO_LOAD_TTL_MS = 5 * 60 * 1000;

interface QuotaPaginationState<T> {
  pageSize: number;
  totalPages: number;
  currentPage: number;
  pageItems: T[];
  setPageSize: (size: number) => void;
  goToPrev: () => void;
  goToNext: () => void;
  loading: boolean;
  loadingScope: 'page' | 'all' | null;
  setLoading: (loading: boolean, scope?: 'page' | 'all' | null) => void;
}

const useQuotaPagination = <T,>(items: T[], defaultPageSize = 6): QuotaPaginationState<T> => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);
  const [loading, setLoadingState] = useState(false);
  const [loadingScope, setLoadingScope] = useState<'page' | 'all' | null>(null);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(items.length / pageSize)),
    [items.length, pageSize]
  );

  const currentPage = useMemo(() => Math.min(page, totalPages), [page, totalPages]);

  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, currentPage, pageSize]);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPage(1);
  }, []);

  const goToPrev = useCallback(() => {
    setPage((prev) => Math.max(1, prev - 1));
  }, []);

  const goToNext = useCallback(() => {
    setPage((prev) => Math.min(totalPages, prev + 1));
  }, [totalPages]);

  const setLoading = useCallback((isLoading: boolean, scope?: 'page' | 'all' | null) => {
    setLoadingState(isLoading);
    setLoadingScope(isLoading ? (scope ?? null) : null);
  }, []);

  return {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
    loading,
    loadingScope,
    setLoading
  };
};

interface CodexPeriodSummaryWindowRequest {
  id: string;
  authIndex: string;
  startAtMs: number;
  endAtMs: number;
  modelFilter: string | null;
}

type CodexQuotaLike = QuotaStatusState & { windows?: CodexQuotaWindow[] };

const normalizeCodexSummaryModelName = (value: unknown): string =>
  typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/^-+|-+$/g, '')
    : '';

const buildCodexPeriodSummaryWindows = (
  items: AuthFileItem[],
  quota: Record<string, QuotaStatusState>
): CodexPeriodSummaryWindowRequest[] => {
  const windows: CodexPeriodSummaryWindowRequest[] = [];

  items.forEach((file) => {
    const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
    if (!authIndex) return;

    const state = quota[file.name] as CodexQuotaLike | undefined;
    if (state?.status !== 'success' || !Array.isArray(state.windows)) return;

    state.windows.forEach((window) => {
      if (
        typeof window.startAtMs !== 'number' ||
        typeof window.resetAtMs !== 'number' ||
        !Number.isFinite(window.startAtMs) ||
        !Number.isFinite(window.resetAtMs) ||
        window.resetAtMs <= window.startAtMs
      ) {
        return;
      }

      windows.push({
        id: getCodexPeriodSummaryKey(file.name, window.id),
        authIndex,
        startAtMs: Math.round(window.startAtMs),
        endAtMs: Math.round(window.resetAtMs),
        modelFilter: window.modelFilter ?? null
      });
    });
  });

  return windows;
};

const createEmptyPeriodSummaries = (): Record<string, QuotaPeriodSummary> => ({});

const toSafeNumber = (value: unknown): number => {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 0;
};

const buildRemotePeriodSummaries = (
  items: unknown
): Record<string, QuotaPeriodSummary> => {
  if (!Array.isArray(items)) return createEmptyPeriodSummaries();

  return items.reduce<Record<string, QuotaPeriodSummary>>((next, item) => {
    if (!item || typeof item !== 'object') return next;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    if (!id) return next;
    next[id] = {
      requests: toSafeNumber(record.requests),
      tokens: toSafeNumber(record.tokens),
      cost: toSafeNumber(record.cost)
    };
    return next;
  }, {});
};

const detailTimestampMs = (detail: UsageDetail): number => {
  if (typeof detail.__timestampMs === 'number' && Number.isFinite(detail.__timestampMs)) {
    return detail.__timestampMs;
  }
  const parsed = Date.parse(detail.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
};

const buildLocalPeriodSummaries = (
  windows: CodexPeriodSummaryWindowRequest[],
  usageDetails: UsageDetail[],
  modelPrices: Record<string, ModelPrice>
): Record<string, QuotaPeriodSummary> => {
  const summaries = windows.reduce<Record<string, QuotaPeriodSummary>>((next, window) => {
    next[window.id] = { requests: 0, tokens: 0, cost: 0 };
    return next;
  }, {});

  usageDetails.forEach((detail) => {
    const authIndex = normalizeAuthIndex(detail.auth_index);
    if (!authIndex) return;
    const timestampMs = detailTimestampMs(detail);
    if (!timestampMs) return;
    const modelName = normalizeCodexSummaryModelName(detail.__modelName);

    windows.forEach((window) => {
      if (authIndex !== window.authIndex) return;
      if (timestampMs < window.startAtMs || timestampMs >= window.endAtMs) return;

      const modelFilter = normalizeCodexSummaryModelName(window.modelFilter);
      if (
        modelFilter &&
        (!modelName || (!modelName.includes(modelFilter) && !modelFilter.includes(modelName)))
      ) {
        return;
      }

      const summary = summaries[window.id];
      if (!summary) return;
      summary.requests += 1;
      summary.tokens += extractTotalTokens(detail);
      summary.cost += calculateCost(detail, modelPrices);
    });
  });

  return summaries;
};

export const useCodexQuotaUsageContext = (
  enabled: boolean,
  pageItems: AuthFileItem[],
  quota: Record<string, QuotaStatusState>
): QuotaUsageContext | undefined => {
  const usageDetails = useUsageStatsStore((state) => state.usageDetails);
  const usageLoading = useUsageStatsStore((state) => state.loading);
  const loadUsageStats = useUsageStatsStore((state) => state.loadUsageStats);
  const [modelPrices, setModelPrices] = useState<Record<string, ModelPrice>>(() =>
    getDefaultModelPrices()
  );
  const [periodSummaries, setPeriodSummaries] = useState<Record<string, QuotaPeriodSummary>>(() =>
    createEmptyPeriodSummaries()
  );
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [useLocalFallback, setUseLocalFallback] = useState(false);

  const summaryWindows = useMemo(
    () => (enabled ? buildCodexPeriodSummaryWindows(pageItems, quota) : []),
    [enabled, pageItems, quota]
  );

  useEffect(() => {
    if (!enabled || !useLocalFallback) return;
    void loadUsageStats({ staleTimeMs: USAGE_STATS_STALE_TIME_MS }).catch(() => {});
  }, [enabled, loadUsageStats, useLocalFallback]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    usageApi
      .getUsageModelPrices()
      .then((sharedPricing) => {
        if (cancelled) return;
        setModelPrices(
          mergeModelPricesWithDefaults(
            normalizeSharedModelPrices(sharedPricing.prices),
            sharedPricing.disabledDefaultModels
          )
        );
      })
      .catch(() => {
        if (!cancelled) {
          setModelPrices(getDefaultModelPrices());
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    let cancelled = false;
    const resetSummaries = () => {
      queueMicrotask(() => {
        if (cancelled) return;
        setPeriodSummaries(createEmptyPeriodSummaries());
        setSummaryLoading(false);
      });
    };

    if (!enabled) {
      resetSummaries();
      return () => {
        cancelled = true;
      };
    }
    if (useLocalFallback) {
      return () => {
        cancelled = true;
      };
    }
    if (summaryWindows.length === 0) {
      resetSummaries();
      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (cancelled) return;
      setSummaryLoading(true);
      usageApi
        .getUsagePeriodSummary({
          windows: summaryWindows.map((window) => ({
            id: window.id,
            auth_index: window.authIndex,
            start_at_ms: window.startAtMs,
            end_at_ms: window.endAtMs,
            model_filter: window.modelFilter
          })),
          model_prices: modelPrices
        })
        .then((response) => {
          if (cancelled) return;
          setPeriodSummaries(buildRemotePeriodSummaries(response.items));
        })
        .catch(() => {
          if (!cancelled) {
            setUseLocalFallback(true);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSummaryLoading(false);
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, modelPrices, summaryWindows, useLocalFallback]);

  const localPeriodSummaries = useMemo(
    () =>
      useLocalFallback
        ? buildLocalPeriodSummaries(summaryWindows, usageDetails, modelPrices)
        : createEmptyPeriodSummaries(),
    [modelPrices, summaryWindows, usageDetails, useLocalFallback]
  );

  if (!enabled) return undefined;
  return {
    periodSummaries: useLocalFallback ? localPeriodSummaries : periodSummaries,
    usageLoading: summaryLoading || (useLocalFallback && usageLoading)
  };
};

interface QuotaSectionProps<TState extends QuotaStatusState, TData> {
  config: QuotaConfig<TState, TData>;
  files: AuthFileItem[];
  loading: boolean;
  disabled: boolean;
}

export function QuotaSection<TState extends QuotaStatusState, TData>({
  config,
  files,
  loading,
  disabled
}: QuotaSectionProps<TState, TData>) {
  const { t } = useTranslation();
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;

  /* Removed useRef */
  const [columns, gridRef] = useGridColumns(380); // Min card width 380px matches SCSS
  const [viewMode, setViewMode] = useState<ViewMode>('paged');
  const [showTooManyWarning, setShowTooManyWarning] = useState(false);

  const filteredFiles = useMemo(() => files.filter((file) => config.filterFn(file)), [
    files,
    config
  ]);
  const showAllAllowed = filteredFiles.length <= MAX_SHOW_ALL_THRESHOLD;
  const effectiveViewMode: ViewMode = viewMode === 'all' && !showAllAllowed ? 'paged' : viewMode;

  const {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
    loading: sectionLoading,
    setLoading
  } = useQuotaPagination(filteredFiles);

  useEffect(() => {
    if (showAllAllowed) return;
    if (viewMode !== 'all') return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setViewMode('paged');
      setShowTooManyWarning(true);
    });

    return () => {
      cancelled = true;
    };
  }, [showAllAllowed, viewMode]);

  // Update page size based on view mode and columns
  useEffect(() => {
    if (effectiveViewMode === 'all') {
      setPageSize(Math.max(1, filteredFiles.length));
    } else {
      // Paged mode: 3 rows * columns, capped to avoid oversized pages.
      setPageSize(Math.min(columns * 3, MAX_ITEMS_PER_PAGE));
    }
  }, [effectiveViewMode, columns, filteredFiles.length, setPageSize]);

  const { quota, loadQuota } = useQuotaLoader(config);
  const usageContext = useCodexQuotaUsageContext(
    config.type === 'codex' && filteredFiles.length > 0 && !disabled,
    pageItems,
    quota as Record<string, QuotaStatusState>
  );

  const pendingQuotaRefreshRef = useRef(false);
  const prevFilesLoadingRef = useRef(loading);

  const handleRefresh = useCallback(() => {
    pendingQuotaRefreshRef.current = true;
    void triggerHeaderRefresh();
  }, []);

  useEffect(() => {
    const wasLoading = prevFilesLoadingRef.current;
    prevFilesLoadingRef.current = loading;

    if (!pendingQuotaRefreshRef.current) return;
    if (loading) return;
    if (!wasLoading) return;

    pendingQuotaRefreshRef.current = false;
    const scope = effectiveViewMode === 'all' ? 'all' : 'page';
    const targets = effectiveViewMode === 'all' ? filteredFiles : pageItems;
    if (targets.length === 0) return;
    loadQuota(targets, scope, setLoading);
  }, [loading, effectiveViewMode, filteredFiles, pageItems, loadQuota, setLoading]);

  useEffect(() => {
    if (loading) return;
    if (filteredFiles.length === 0) {
      setQuota({});
      return;
    }
    setQuota((prev) => {
      const nextState: Record<string, TState> = {};
      filteredFiles.forEach((file) => {
        const cached = prev[file.name];
        if (cached) {
          nextState[file.name] = cached;
        }
      });
      return nextState;
    });
  }, [filteredFiles, loading, setQuota]);

  useEffect(() => {
    if (!config.autoLoad) return;
    if (loading || disabled || sectionLoading) return;
    if (pageItems.length === 0) return;

    const now = Date.now();
    const ttl = config.autoLoadTtlMs ?? DEFAULT_AUTO_LOAD_TTL_MS;
    const targets = pageItems.filter((file) => {
      if (file.disabled) return false;
      const state = quota[file.name] as (QuotaStatusState & { loadedAt?: number }) | undefined;
      if (!state) return true;
      if (state.status === 'loading') return false;
      if (!state.loadedAt) return state.status === 'idle' || state.status === 'error';
      return now - state.loadedAt > ttl;
    });

    if (targets.length === 0) return;
    loadQuota(targets, 'page', setLoading);
  }, [
    config.autoLoad,
    config.autoLoadTtlMs,
    disabled,
    loadQuota,
    loading,
    pageItems,
    quota,
    sectionLoading,
    setLoading
  ]);

  const refreshQuotaForFile = useCallback(
    async (file: AuthFileItem) => {
      if (disabled || file.disabled) return;
      if (quota[file.name]?.status === 'loading') return;

      setQuota((prev) => ({
        ...prev,
        [file.name]: config.buildLoadingState()
      }));

      try {
        const data = await config.fetchQuota(file, t);
        setQuota((prev) => ({
          ...prev,
          [file.name]: {
            ...config.buildSuccessState(data),
            loadedAt: Date.now()
          } as TState
        }));
        showNotification(t('auth_files.quota_refresh_success', { name: file.name }), 'success');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status = getStatusFromError(err);
        setQuota((prev) => ({
          ...prev,
          [file.name]: {
            ...config.buildErrorState(message, status),
            loadedAt: Date.now()
          } as TState
        }));
        showNotification(
          t('auth_files.quota_refresh_failed', { name: file.name, message }),
          'error'
        );
      }
    },
    [config, disabled, quota, setQuota, showNotification, t]
  );

  const titleNode = (
    <div className={styles.titleWrapper}>
      <span>{t(`${config.i18nPrefix}.title`)}</span>
      {filteredFiles.length > 0 && (
        <span className={styles.countBadge}>
          {filteredFiles.length}
        </span>
      )}
    </div>
  );

  const isRefreshing = sectionLoading || loading;

  return (
    <Card
      title={titleNode}
      extra={
        <div className={styles.headerActions}>
          <div className={styles.viewModeToggle}>
            <Button
              variant="secondary"
              size="sm"
              className={`${styles.viewModeButton} ${
                effectiveViewMode === 'paged' ? styles.viewModeButtonActive : ''
              }`}
              onClick={() => setViewMode('paged')}
            >
              {t('auth_files.view_mode_paged')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={`${styles.viewModeButton} ${
                effectiveViewMode === 'all' ? styles.viewModeButtonActive : ''
              }`}
              onClick={() => {
                if (filteredFiles.length > MAX_SHOW_ALL_THRESHOLD) {
                  setShowTooManyWarning(true);
                } else {
                  setViewMode('all');
                }
              }}
            >
              {t('auth_files.view_mode_all')}
            </Button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className={styles.refreshAllButton}
            onClick={handleRefresh}
            disabled={disabled || isRefreshing}
            loading={isRefreshing}
            title={t('quota_management.refresh_all_credentials')}
            aria-label={t('quota_management.refresh_all_credentials')}
          >
            {!isRefreshing && <IconRefreshCw size={16} />}
            {t('quota_management.refresh_all_credentials')}
          </Button>
        </div>
      }
    >
      {filteredFiles.length === 0 ? (
        <EmptyState
          title={t(`${config.i18nPrefix}.empty_title`)}
          description={t(`${config.i18nPrefix}.empty_desc`)}
        />
      ) : (
        <>
          <div ref={gridRef} className={config.gridClassName}>
            {pageItems.map((item) => (
              <QuotaCard
                key={item.name}
                item={item}
                quota={quota[item.name]}
                resolvedTheme={resolvedTheme}
                i18nPrefix={config.i18nPrefix}
                cardIdleMessageKey={config.cardIdleMessageKey}
                cardClassName={config.cardClassName}
                defaultType={config.type}
                canRefresh={!disabled && !item.disabled}
                onRefresh={() => void refreshQuotaForFile(item)}
                usageContext={usageContext}
                renderQuotaItems={config.renderQuotaItems}
              />
            ))}
          </div>
          {filteredFiles.length > pageSize && effectiveViewMode === 'paged' && (
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToPrev}
                disabled={currentPage <= 1}
              >
                {t('auth_files.pagination_prev')}
              </Button>
              <div className={styles.pageInfo}>
                {t('auth_files.pagination_info', {
                  current: currentPage,
                  total: totalPages,
                  count: filteredFiles.length
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToNext}
                disabled={currentPage >= totalPages}
              >
                {t('auth_files.pagination_next')}
              </Button>
            </div>
          )}
        </>
      )}
      {showTooManyWarning && (
        <div className={styles.warningOverlay} onClick={() => setShowTooManyWarning(false)}>
          <div className={styles.warningModal} onClick={(e) => e.stopPropagation()}>
            <p>{t('auth_files.too_many_files_warning')}</p>
            <Button variant="primary" size="sm" onClick={() => setShowTooManyWarning(false)}>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
