import { useCallback, useEffect, useMemo, useState } from 'react';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { USAGE_STATS_STALE_TIME_MS, useUsageStatsStore } from '@/stores';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/ui/EmptyState';
import { authFilesApi } from '@/services/api/authFiles';
import { usageApi } from '@/services/api/usage';
import type { AuthFileItem } from '@/types';
import {
  calculateCost,
  collectUsageDetailsWithEndpoint,
  extractCacheCreationTokens,
  extractCacheReadTokens,
  extractCachedTokensTotal,
  extractTotalTokens,
  formatCompactNumber,
  formatUsd,
  getDefaultModelPrices,
  mergeModelPricesWithDefaults,
  normalizeAuthIndex,
  normalizeSharedModelPrices,
  type ModelPrice,
  type UsageDetailWithEndpoint,
} from '@/utils/usage';
import { parseTimestampMs } from '@/utils/timestamp';
import { IconRefreshCw, IconSearch } from '@/components/ui/icons';
import styles from './SkViewPage.module.scss';

type SubjectKind = 'all' | 'auth' | 'source';
type TimeRange = 'all' | 'today' | '24h' | '7d';

interface SkSubject {
  id: string;
  kind: SubjectKind;
  label: string;
  subtitle: string;
  type: string;
  authIndex?: string;
  source?: string;
  disabled?: boolean;
  priority?: number | null;
  details: UsageDetailWithEndpoint[];
}

interface Summary {
  requests: number;
  success: number;
  failure: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cachedTokens: number;
  cost: number;
  averageLatencyMs: number | null;
}

interface ModelRow extends Summary {
  model: string;
}

interface EndpointRow {
  key: string;
  requests: number;
  failures: number;
  tokens: number;
  cost: number;
  lastAt: number;
}

const ALL_SUBJECT_ID = 'all';
const ALL_MODEL = 'all';
const ALL_PROVIDER = 'all';

const TIME_RANGE_OPTIONS = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今日' },
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
] satisfies Array<{ value: TimeRange; label: string }>;

const formatType = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized === 'gemini-cli') return 'Gemini CLI';
  if (normalized === 'iflow') return 'iFlow';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const getFileType = (file: AuthFileItem) =>
  String(file.type ?? file.provider ?? 'unknown').trim().toLowerCase() || 'unknown';

const getFileAuthIndex = (file: AuthFileItem) =>
  normalizeAuthIndex(file['auth_index'] ?? file.authIndex);

const getPriority = (file: AuthFileItem): number | null => {
  const raw = file.priority ?? file['priority'];
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const displaySource = (source: string) => {
  if (!source) return '-';
  if (source.startsWith('k:')) return `sk-${source.slice(2, 8)}...${source.slice(-4)}`;
  if (source.startsWith('m:')) return source.slice(2);
  if (source.startsWith('t:')) return source.slice(2);
  return source;
};

const createEmptySummary = (): Summary => ({
  requests: 0,
  success: 0,
  failure: 0,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cachedTokens: 0,
  cost: 0,
  averageLatencyMs: null,
});

const summarizeDetails = (
  details: UsageDetailWithEndpoint[],
  modelPrices: Record<string, ModelPrice>
): Summary => {
  const summary = createEmptySummary();
  let latencyTotal = 0;
  let latencyCount = 0;

  details.forEach((detail) => {
    summary.requests += 1;
    if (detail.failed) {
      summary.failure += 1;
    } else {
      summary.success += 1;
    }

    const tokens = detail.tokens;
    const inputTokens = Number(tokens.input_tokens);
    const outputTokens = Number(tokens.output_tokens);
    const reasoningTokens = Number(tokens.reasoning_tokens);

    summary.inputTokens += Number.isFinite(inputTokens) ? Math.max(inputTokens, 0) : 0;
    summary.outputTokens += Number.isFinite(outputTokens) ? Math.max(outputTokens, 0) : 0;
    summary.reasoningTokens += Number.isFinite(reasoningTokens) ? Math.max(reasoningTokens, 0) : 0;
    summary.cacheReadTokens += extractCacheReadTokens(tokens);
    summary.cacheCreationTokens += extractCacheCreationTokens(tokens);
    summary.cachedTokens += extractCachedTokensTotal(tokens);
    summary.tokens += extractTotalTokens(detail);
    summary.cost += calculateCost(detail, modelPrices);

    const latency = Number(detail.latency_ms);
    if (Number.isFinite(latency) && latency >= 0) {
      latencyTotal += latency;
      latencyCount += 1;
    }
  });

  summary.averageLatencyMs = latencyCount > 0 ? latencyTotal / latencyCount : null;
  return summary;
};

const formatLatency = (value: number | null) => {
  if (value === null || !Number.isFinite(value)) return '-';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s`;
  return `${Math.round(value)}ms`;
};

const formatPercent = (value: number) =>
  Number.isFinite(value) ? `${value.toFixed(value >= 99.95 || value < 10 ? 1 : 1)}%` : '-';

const formatDateTime = (timestampMs: number) => {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '-';
  return new Date(timestampMs).toLocaleString();
};

const getTimeRangeStart = (range: TimeRange, now = Date.now()) => {
  if (range === 'today') {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return today.getTime();
  }
  if (range === '24h') return now - 24 * 60 * 60 * 1000;
  if (range === '7d') return now - 7 * 24 * 60 * 60 * 1000;
  return 0;
};

const detailTimestamp = (detail: UsageDetailWithEndpoint) =>
  typeof detail.__timestampMs === 'number' && detail.__timestampMs > 0
    ? detail.__timestampMs
    : parseTimestampMs(detail.timestamp);

const withinTimeRange = (detail: UsageDetailWithEndpoint, range: TimeRange) => {
  if (range === 'all') return true;
  const timestamp = detailTimestamp(detail);
  const start = getTimeRangeStart(range);
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= Date.now();
};

const matchesModel = (detail: UsageDetailWithEndpoint, model: string) =>
  model === ALL_MODEL || detail.__modelName === model;

const successRate = (summary: Summary) =>
  summary.requests > 0 ? (summary.success / summary.requests) * 100 : 100;

const ratioPercent = (value: number, total: number) =>
  total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0;

const buildSubjects = (
  files: AuthFileItem[],
  details: UsageDetailWithEndpoint[]
): SkSubject[] => {
  const detailsByAuthIndex = new Map<string, UsageDetailWithEndpoint[]>();
  const detailsBySource = new Map<string, UsageDetailWithEndpoint[]>();

  details.forEach((detail) => {
    const authIndex = normalizeAuthIndex(detail.auth_index);
    if (authIndex) {
      const bucket = detailsByAuthIndex.get(authIndex);
      if (bucket) bucket.push(detail);
      else detailsByAuthIndex.set(authIndex, [detail]);
    }

    if (detail.source) {
      const bucket = detailsBySource.get(detail.source);
      if (bucket) bucket.push(detail);
      else detailsBySource.set(detail.source, [detail]);
    }
  });

  const subjects: SkSubject[] = [
    {
      id: ALL_SUBJECT_ID,
      kind: 'all',
      label: '全部 SK / 凭证',
      subtitle: '跨全部来源汇总',
      type: 'all',
      details,
    },
  ];
  const coveredAuthIndices = new Set<string>();

  files.forEach((file) => {
    const authIndex = getFileAuthIndex(file);
    if (!authIndex) return;
    coveredAuthIndices.add(authIndex);
    subjects.push({
      id: `auth:${authIndex}`,
      kind: 'auth',
      label: file.name,
      subtitle: `auth_index ${authIndex}`,
      type: getFileType(file),
      authIndex,
      disabled: Boolean(file.disabled),
      priority: getPriority(file),
      details: detailsByAuthIndex.get(authIndex) ?? [],
    });
  });

  detailsByAuthIndex.forEach((bucket, authIndex) => {
    if (coveredAuthIndices.has(authIndex)) return;
    subjects.push({
      id: `auth:${authIndex}`,
      kind: 'auth',
      label: `auth_index ${authIndex}`,
      subtitle: '未匹配认证文件',
      type: 'unknown',
      authIndex,
      details: bucket,
    });
  });

  detailsBySource.forEach((bucket, source) => {
    subjects.push({
      id: `source:${source}`,
      kind: 'source',
      label: displaySource(source),
      subtitle: source.startsWith('k:') ? 'SK 指纹来源' : '请求来源',
      type: 'source',
      source,
      details: bucket,
    });
  });

  return subjects.sort((a, b) => {
    if (a.id === ALL_SUBJECT_ID) return -1;
    if (b.id === ALL_SUBJECT_ID) return 1;
    return b.details.length - a.details.length || a.label.localeCompare(b.label);
  });
};

const buildModelRows = (
  details: UsageDetailWithEndpoint[],
  modelPrices: Record<string, ModelPrice>
): ModelRow[] => {
  const buckets = new Map<string, UsageDetailWithEndpoint[]>();
  details.forEach((detail) => {
    const model = detail.__modelName || 'unknown';
    const bucket = buckets.get(model);
    if (bucket) bucket.push(detail);
    else buckets.set(model, [detail]);
  });

  return Array.from(buckets.entries())
    .map(([model, modelDetails]) => ({ model, ...summarizeDetails(modelDetails, modelPrices) }))
    .sort((a, b) => b.requests - a.requests);
};

const buildEndpointRows = (
  details: UsageDetailWithEndpoint[],
  modelPrices: Record<string, ModelPrice>
): EndpointRow[] => {
  const buckets = new Map<string, UsageDetailWithEndpoint[]>();
  details.forEach((detail) => {
    const key = detail.__endpoint || detail.__endpointPath || 'unknown';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(detail);
    else buckets.set(key, [detail]);
  });

  return Array.from(buckets.entries())
    .map(([key, endpointDetails]) => {
      const summary = summarizeDetails(endpointDetails, modelPrices);
      const lastAt = endpointDetails.reduce(
        (max, detail) => Math.max(max, detailTimestamp(detail) || 0),
        0
      );
      return {
        key,
        requests: summary.requests,
        failures: summary.failure,
        tokens: summary.tokens,
        cost: summary.cost,
        lastAt,
      };
    })
    .filter((row) => row.failures > 0)
    .sort((a, b) => b.failures - a.failures || b.requests - a.requests);
};

const tokenizeSearch = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

export function SkViewPage() {
  const usage = useUsageStatsStore((state) => state.usage);
  const usageLoading = useUsageStatsStore((state) => state.loading);
  const usageError = useUsageStatsStore((state) => state.error);
  const lastRefreshedAt = useUsageStatsStore((state) => state.lastRefreshedAt);
  const loadUsageStats = useUsageStatsStore((state) => state.loadUsageStats);
  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [modelPrices, setModelPrices] = useState<Record<string, ModelPrice>>(() =>
    getDefaultModelPrices()
  );
  const [selectedSubjectId, setSelectedSubjectId] = useState(ALL_SUBJECT_ID);
  const [subjectSearch, setSubjectSearch] = useState('');
  const [providerFilter, setProviderFilter] = useState(ALL_PROVIDER);
  const [modelFilter, setModelFilter] = useState(ALL_MODEL);
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [failedOnly, setFailedOnly] = useState(false);

  const refreshData = useCallback(async () => {
    setFilesLoading(true);
    try {
      const [authResponse, sharedPricing] = await Promise.all([
        authFilesApi.list(),
        usageApi.getUsageModelPrices().catch(() => null),
        loadUsageStats({ force: true, staleTimeMs: USAGE_STATS_STALE_TIME_MS }),
      ]);

      setFiles(Array.isArray(authResponse.files) ? authResponse.files : []);
      if (sharedPricing) {
        setModelPrices(
          mergeModelPricesWithDefaults(
            normalizeSharedModelPrices(sharedPricing.prices),
            sharedPricing.disabledDefaultModels
          )
        );
      }
    } finally {
      setFilesLoading(false);
    }
  }, [loadUsageStats]);

  useHeaderRefresh(refreshData, true);

  useEffect(() => {
    void refreshData().catch(() => {
      setFilesLoading(false);
    });
  }, [refreshData]);

  const allDetails = useMemo(() => (usage ? collectUsageDetailsWithEndpoint(usage) : []), [usage]);
  const subjects = useMemo(() => buildSubjects(files, allDetails), [allDetails, files]);

  useEffect(() => {
    if (subjects.some((subject) => subject.id === selectedSubjectId)) return;
    setSelectedSubjectId(ALL_SUBJECT_ID);
  }, [selectedSubjectId, subjects]);

  const providerOptions = useMemo(() => {
    const providers = new Set<string>();
    subjects.forEach((subject) => {
      if (subject.type && subject.type !== 'all' && subject.type !== 'source') {
        providers.add(subject.type);
      }
    });
    return [
      { value: ALL_PROVIDER, label: '全部提供方' },
      ...Array.from(providers)
        .sort((a, b) => a.localeCompare(b))
        .map((provider) => ({ value: provider, label: formatType(provider) })),
    ];
  }, [subjects]);

  const visibleSubjects = useMemo(() => {
    const tokens = tokenizeSearch(subjectSearch);
    return subjects.filter((subject) => {
      const providerMatched =
        providerFilter === ALL_PROVIDER ||
        subject.type === providerFilter ||
        subject.id === ALL_SUBJECT_ID;
      if (!providerMatched) return false;
      if (!tokens.length) return true;
      const haystack = [
        subject.label,
        subject.subtitle,
        subject.type,
        subject.authIndex,
        subject.source,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [providerFilter, subjectSearch, subjects]);

  const selectedSubject =
    subjects.find((subject) => subject.id === selectedSubjectId) ?? subjects[0];

  const subjectOptions = useMemo(
    () =>
      subjects.map((subject) => ({
        value: subject.id,
        label:
          subject.id === ALL_SUBJECT_ID
            ? subject.label
            : `${formatType(subject.type)} · ${subject.label}`,
      })),
    [subjects]
  );

  const subjectBaseDetails = selectedSubject?.details ?? [];
  const modelOptions = useMemo(() => {
    const models = new Set<string>();
    subjectBaseDetails.forEach((detail) => {
      if (withinTimeRange(detail, timeRange) && detail.__modelName) {
        models.add(detail.__modelName);
      }
    });
    return [
      { value: ALL_MODEL, label: '全部模型' },
      ...Array.from(models)
        .sort((a, b) => a.localeCompare(b))
        .map((model) => ({ value: model, label: model })),
    ];
  }, [subjectBaseDetails, timeRange]);

  useEffect(() => {
    if (modelFilter === ALL_MODEL || modelOptions.some((option) => option.value === modelFilter)) {
      return;
    }
    setModelFilter(ALL_MODEL);
  }, [modelFilter, modelOptions]);

  const filteredDetails = useMemo(
    () =>
      subjectBaseDetails.filter(
        (detail) =>
          withinTimeRange(detail, timeRange) &&
          matchesModel(detail, modelFilter) &&
          (!failedOnly || detail.failed)
      ),
    [failedOnly, modelFilter, subjectBaseDetails, timeRange]
  );

  const allFilteredDetails = useMemo(
    () =>
      allDetails.filter(
        (detail) =>
          withinTimeRange(detail, timeRange) &&
          matchesModel(detail, modelFilter) &&
          (!failedOnly || detail.failed)
      ),
    [allDetails, failedOnly, modelFilter, timeRange]
  );

  const summary = useMemo(
    () => summarizeDetails(filteredDetails, modelPrices),
    [filteredDetails, modelPrices]
  );
  const allSummary = useMemo(
    () => summarizeDetails(allFilteredDetails, modelPrices),
    [allFilteredDetails, modelPrices]
  );
  const modelRows = useMemo(
    () => buildModelRows(filteredDetails, modelPrices),
    [filteredDetails, modelPrices]
  );
  const endpointRows = useMemo(
    () => buildEndpointRows(filteredDetails, modelPrices),
    [filteredDetails, modelPrices]
  );
  const recentRows = useMemo(
    () =>
      [...filteredDetails]
        .sort((a, b) => detailTimestamp(b) - detailTimestamp(a))
        .slice(0, 80),
    [filteredDetails]
  );

  const successRateValue = successRate(summary);
  const requestShare = ratioPercent(summary.requests, allSummary.requests);
  const tokenShare = ratioPercent(summary.tokens, allSummary.tokens);
  const costShare = ratioPercent(summary.cost, allSummary.cost);
  const selectedDisplay = selectedSubject ?? {
    label: '全部 SK / 凭证',
    subtitle: '跨全部来源汇总',
    type: 'all',
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>SK 视图</h1>
          <p className={styles.description}>
            按单个 SK、认证文件或来源聚合查看请求、Tokens、费用、失败和最近 Trace。
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => void refreshData()}
          loading={usageLoading || filesLoading}
          className={styles.refreshButton}
        >
          {!usageLoading && !filesLoading && <IconRefreshCw size={16} />}
          刷新数据
        </Button>
      </div>

      <div className={styles.filterBar}>
        <div className={styles.filterControlWide}>
          <label>选择 SK / 认证文件</label>
          <Select
            value={selectedSubjectId}
            options={subjectOptions}
            onChange={setSelectedSubjectId}
            ariaLabel="选择 SK / 认证文件"
          />
        </div>
        <div className={styles.filterControl}>
          <label>提供方</label>
          <Select
            value={providerFilter}
            options={providerOptions}
            onChange={setProviderFilter}
            ariaLabel="提供方"
          />
        </div>
        <div className={styles.filterControl}>
          <label>模型</label>
          <Select
            value={modelFilter}
            options={modelOptions}
            onChange={setModelFilter}
            ariaLabel="模型"
          />
        </div>
        <div className={styles.filterControl}>
          <label>时间范围</label>
          <Select
            value={timeRange}
            options={TIME_RANGE_OPTIONS}
            onChange={(value) => setTimeRange(value as TimeRange)}
            ariaLabel="时间范围"
          />
        </div>
        <label className={styles.failedToggle}>
          <input
            type="checkbox"
            checked={failedOnly}
            onChange={(event) => setFailedOnly(event.target.checked)}
          />
          仅异常
        </label>
      </div>

      {usageError && <div className={styles.errorBanner}>使用统计加载失败：{usageError}</div>}

      <div className={styles.layoutGrid}>
        <aside className={styles.subjectPanel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>SK 列表</h2>
              <span>{visibleSubjects.length} 个可选对象</span>
            </div>
          </div>
          <Input
            value={subjectSearch}
            onChange={(event) => setSubjectSearch(event.target.value)}
            placeholder="搜索文件名、auth_index、sk 指纹"
            className={styles.searchInput}
            rightElement={<IconSearch size={16} />}
          />
          <div className={styles.subjectList}>
            {visibleSubjects.map((subject) => {
              const active = subject.id === selectedSubjectId;
              const subjectSummary = summarizeDetails(
                subject.details.filter((detail) => withinTimeRange(detail, timeRange)),
                modelPrices
              );
              const subjectSuccessRate = successRate(subjectSummary);
              return (
                <button
                  type="button"
                  key={subject.id}
                  className={`${styles.subjectItem} ${active ? styles.subjectItemActive : ''}`}
                  onClick={() => setSelectedSubjectId(subject.id)}
                >
                  <div className={styles.subjectTopLine}>
                    <span className={styles.providerBadge}>{formatType(subject.type)}</span>
                    <span className={styles.subjectHealthDot} data-good={subjectSuccessRate >= 95} />
                    {subject.priority !== null && subject.priority !== undefined && (
                      <span className={styles.priorityBadge}>P{subject.priority}</span>
                    )}
                    {subject.disabled && <span className={styles.disabledBadge}>停用</span>}
                  </div>
                  <strong title={subject.label}>{subject.label}</strong>
                  <span className={styles.subjectSubtitle}>{subject.subtitle}</span>
                  <div className={styles.subjectStats}>
                    <span>{formatCompactNumber(subjectSummary.requests)} 请求</span>
                    <span>{formatPercent(subjectSuccessRate)}</span>
                    <span>{formatUsd(subjectSummary.cost)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <main className={styles.mainColumn}>
          <section className={styles.selectedHeaderCard}>
            <div className={styles.selectedTitleGroup}>
              <span className={styles.providerBadgeLarge}>{formatType(selectedDisplay.type)}</span>
              <div>
                <h2>{selectedDisplay.label}</h2>
                <p>{selectedDisplay.subtitle}</p>
              </div>
            </div>
            <div className={styles.lastRefresh}>
              {lastRefreshedAt ? `最后刷新 ${formatDateTime(lastRefreshedAt)}` : '尚未刷新'}
            </div>
          </section>

          <section className={styles.kpiGrid}>
            <div className={styles.kpiCard}>
              <span>请求</span>
              <strong>{summary.requests.toLocaleString()}</strong>
              <em>占全局 {formatPercent(requestShare)}</em>
            </div>
            <div className={styles.kpiCard}>
              <span>Tokens</span>
              <strong>{formatCompactNumber(summary.tokens)}</strong>
              <em>占全局 {formatPercent(tokenShare)}</em>
            </div>
            <div className={styles.kpiCard}>
              <span>估算费用</span>
              <strong>{formatUsd(summary.cost)}</strong>
              <em>占全局 {formatPercent(costShare)}</em>
            </div>
            <div className={styles.kpiCard}>
              <span>成功率</span>
              <strong>{formatPercent(successRateValue)}</strong>
              <em>{summary.failure.toLocaleString()} 失败</em>
            </div>
            <div className={styles.kpiCard}>
              <span>平均延迟</span>
              <strong>{formatLatency(summary.averageLatencyMs)}</strong>
              <em>{summary.requests.toLocaleString()} 样本</em>
            </div>
          </section>

          <section className={styles.usageBand}>
            <div className={styles.bandRow}>
              <div>
                <strong>请求占比</strong>
                <span>{summary.requests.toLocaleString()} / {allSummary.requests.toLocaleString()}</span>
              </div>
              <div className={styles.progressTrack}>
                <span style={{ width: `${requestShare}%` }} />
              </div>
            </div>
            <div className={styles.bandRow}>
              <div>
                <strong>Token 占比</strong>
                <span>{formatCompactNumber(summary.tokens)} / {formatCompactNumber(allSummary.tokens)}</span>
              </div>
              <div className={styles.progressTrack}>
                <span style={{ width: `${tokenShare}%` }} />
              </div>
            </div>
            <div className={styles.bandRow}>
              <div>
                <strong>费用占比</strong>
                <span>{formatUsd(summary.cost)} / {formatUsd(allSummary.cost)}</span>
              </div>
              <div className={styles.progressTrack}>
                <span style={{ width: `${costShare}%` }} />
              </div>
            </div>
            <div className={styles.tokenBreakdown}>
              <span>输入 {formatCompactNumber(summary.inputTokens)}</span>
              <span>输出 {formatCompactNumber(summary.outputTokens)}</span>
              <span>缓存读 {formatCompactNumber(summary.cacheReadTokens)}</span>
              <span>缓存写 {formatCompactNumber(summary.cacheCreationTokens)}</span>
              <span>思考 {formatCompactNumber(summary.reasoningTokens)}</span>
            </div>
          </section>

          <section className={styles.tableSection}>
            <div className={styles.sectionHeader}>
              <h2>SK 请求明细</h2>
              <span>显示最近 {recentRows.length} 条</span>
            </div>
            {recentRows.length === 0 ? (
              <EmptyState title="暂无请求" description="当前筛选条件下没有匹配的使用记录。" />
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.requestTable}>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>模型</th>
                      <th>状态</th>
                      <th>输入</th>
                      <th>输出</th>
                      <th>缓存</th>
                      <th>费用</th>
                      <th>延迟</th>
                      <th>Trace</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentRows.map((detail, index) => {
                      const rowCost = calculateCost(detail, modelPrices);
                      const timestamp = detailTimestamp(detail);
                      return (
                        <tr
                          key={`${detail.timestamp}-${detail.__modelName}-${detail.__endpoint}-${index}`}
                          className={detail.failed ? styles.failedRow : undefined}
                        >
                          <td>{formatDateTime(timestamp)}</td>
                          <td title={detail.__modelName}>{detail.__modelName || '-'}</td>
                          <td>
                            <span className={detail.failed ? styles.statusBad : styles.statusGood}>
                              {detail.failed ? '失败' : '成功'}
                            </span>
                          </td>
                          <td>{formatCompactNumber(Number(detail.tokens.input_tokens) || 0)}</td>
                          <td>{formatCompactNumber(Number(detail.tokens.output_tokens) || 0)}</td>
                          <td>{formatCompactNumber(extractCachedTokensTotal(detail.tokens))}</td>
                          <td>{formatUsd(rowCost)}</td>
                          <td>{formatLatency(detail.latency_ms ?? null)}</td>
                          <td title={detail.__endpoint || detail.__requestId || '-'}>
                            {detail.__requestId || detail.__endpointPath || detail.__endpoint || '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>

        <aside className={styles.sideColumn}>
          <section className={styles.sideCard}>
            <div className={styles.sectionHeader}>
              <h2>模型分布</h2>
              <span>{modelRows.length} 个模型</span>
            </div>
            <div className={styles.barList}>
              {modelRows.slice(0, 8).map((row) => {
                const pct = ratioPercent(row.requests, summary.requests);
                return (
                  <div key={row.model} className={styles.barItem}>
                    <div>
                      <strong title={row.model}>{row.model}</strong>
                      <span>{row.requests.toLocaleString()} 请求 · {formatUsd(row.cost)}</span>
                    </div>
                    <div className={styles.miniBar}>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
              {modelRows.length === 0 && <div className={styles.muted}>暂无模型数据</div>}
            </div>
          </section>

          <section className={styles.sideCard}>
            <div className={styles.sectionHeader}>
              <h2>异常入口</h2>
              <span>{summary.failure.toLocaleString()} 失败</span>
            </div>
            <div className={styles.endpointList}>
              {endpointRows.slice(0, 6).map((row) => (
                <div key={row.key} className={styles.endpointItem}>
                  <strong title={row.key}>{row.key}</strong>
                  <span>
                    {row.failures.toLocaleString()} 失败 / {row.requests.toLocaleString()} 请求
                  </span>
                  <em>{formatDateTime(row.lastAt)}</em>
                </div>
              ))}
              {endpointRows.length === 0 && <div className={styles.muted}>暂无异常数据</div>}
            </div>
          </section>

          <section className={styles.sideCard}>
            <div className={styles.sectionHeader}>
              <h2>最近请求</h2>
              <span>快速定位</span>
            </div>
            <div className={styles.recentList}>
              {recentRows.slice(0, 8).map((detail, index) => (
                <div key={`${detail.timestamp}-${index}`} className={styles.recentItem}>
                  <span className={detail.failed ? styles.statusBad : styles.statusGood}>
                    {detail.failed ? '失败' : '成功'}
                  </span>
                  <strong title={detail.__modelName}>{detail.__modelName || '-'}</strong>
                  <em>{formatCompactNumber(extractTotalTokens(detail))} tokens</em>
                </div>
              ))}
              {recentRows.length === 0 && <div className={styles.muted}>暂无请求</div>}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
