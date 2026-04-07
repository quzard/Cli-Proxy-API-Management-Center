import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { getModelPrice, resolveModelPriceKey, type ModelPrice } from '@/utils/usage';
import styles from '@/pages/UsagePage.module.scss';

export interface PriceSettingsCardProps {
  modelNames: string[];
  modelPrices: Record<string, ModelPrice>;
  onPricesChange: (prices: Record<string, ModelPrice>) => void;
}

export function PriceSettingsCard({
  modelNames,
  modelPrices,
  onPricesChange
}: PriceSettingsCardProps) {
  const { t } = useTranslation();
  const buildPrice = (prompt: number, completion: number, cacheRead: number, cacheCreation: number): ModelPrice => ({
    prompt,
    completion,
    cache: cacheRead,
    cacheRead,
    cacheCreation
  });

  // Add form state
  const [selectedModel, setSelectedModel] = useState('');
  const [promptPrice, setPromptPrice] = useState('');
  const [completionPrice, setCompletionPrice] = useState('');
  const [cacheReadPrice, setCacheReadPrice] = useState('');
  const [cacheCreationPrice, setCacheCreationPrice] = useState('');

  // Edit modal state
  const [editModel, setEditModel] = useState<string | null>(null);
  const [editPrompt, setEditPrompt] = useState('');
  const [editCompletion, setEditCompletion] = useState('');
  const [editCacheRead, setEditCacheRead] = useState('');
  const [editCacheCreation, setEditCacheCreation] = useState('');

  const getEditableModelKey = (model: string) => resolveModelPriceKey(model, modelPrices) || model;

  const handleSavePrice = () => {
    if (!selectedModel) return;
    const prompt = parseFloat(promptPrice) || 0;
    const completion = parseFloat(completionPrice) || 0;
    const cacheRead = cacheReadPrice.trim() === '' ? prompt : parseFloat(cacheReadPrice) || 0;
    const cacheCreation =
      cacheCreationPrice.trim() === '' ? cacheRead : parseFloat(cacheCreationPrice) || 0;
    const targetModel = getEditableModelKey(selectedModel);
    const newPrices = {
      ...modelPrices,
      [targetModel]: buildPrice(prompt, completion, cacheRead, cacheCreation)
    };
    onPricesChange(newPrices);
    setSelectedModel('');
    setPromptPrice('');
    setCompletionPrice('');
    setCacheReadPrice('');
    setCacheCreationPrice('');
  };

  const handleDeletePrice = (model: string) => {
    const newPrices = { ...modelPrices };
    delete newPrices[model];
    onPricesChange(newPrices);
  };

  const handleOpenEdit = (model: string) => {
    const price = modelPrices[model];
    setEditModel(model);
    setEditPrompt(price?.prompt?.toString() || '');
    setEditCompletion(price?.completion?.toString() || '');
    setEditCacheRead((price?.cacheRead ?? price?.cache ?? 0).toString());
    setEditCacheCreation((price?.cacheCreation ?? price?.cacheRead ?? price?.cache ?? 0).toString());
  };

  const handleSaveEdit = () => {
    if (!editModel) return;
    const prompt = parseFloat(editPrompt) || 0;
    const completion = parseFloat(editCompletion) || 0;
    const cacheRead = editCacheRead.trim() === '' ? prompt : parseFloat(editCacheRead) || 0;
    const cacheCreation =
      editCacheCreation.trim() === '' ? cacheRead : parseFloat(editCacheCreation) || 0;
    const newPrices = {
      ...modelPrices,
      [editModel]: buildPrice(prompt, completion, cacheRead, cacheCreation)
    };
    onPricesChange(newPrices);
    setEditModel(null);
  };

  const handleModelSelect = (value: string) => {
    setSelectedModel(value);
    const price = getModelPrice(value, modelPrices);
    if (price) {
      setPromptPrice(price.prompt.toString());
      setCompletionPrice(price.completion.toString());
      setCacheReadPrice((price.cacheRead ?? price.cache).toString());
      setCacheCreationPrice((price.cacheCreation ?? price.cacheRead ?? price.cache).toString());
    } else {
      setPromptPrice('');
      setCompletionPrice('');
      setCacheReadPrice('');
      setCacheCreationPrice('');
    }
  };

  const options = useMemo(
    () => [
      { value: '', label: t('usage_stats.model_price_select_placeholder') },
      ...modelNames.map((name) => ({ value: name, label: name }))
    ],
    [modelNames, t]
  );

  const savedPrices = useMemo(
    () => Object.entries(modelPrices).sort(([left], [right]) => left.localeCompare(right)),
    [modelPrices]
  );

  return (
    <Card title={t('usage_stats.model_price_settings')}>
      <div className={styles.pricingSection}>
        {/* Price Form */}
        <div className={styles.priceForm}>
          <div className={styles.formRow}>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_name')}</label>
              <Select
                value={selectedModel}
                options={options}
                onChange={handleModelSelect}
                placeholder={t('usage_stats.model_price_select_placeholder')}
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_prompt')} ($/1M)</label>
              <Input
                type="number"
                value={promptPrice}
                onChange={(e) => setPromptPrice(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_completion')} ($/1M)</label>
              <Input
                type="number"
                value={completionPrice}
                onChange={(e) => setCompletionPrice(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_cache_read')} ($/1M)</label>
              <Input
                type="number"
                value={cacheReadPrice}
                onChange={(e) => setCacheReadPrice(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <div className={styles.formField}>
              <label>{t('usage_stats.model_price_cache_creation')} ($/1M)</label>
              <Input
                type="number"
                value={cacheCreationPrice}
                onChange={(e) => setCacheCreationPrice(e.target.value)}
                placeholder="0.00"
                step="0.0001"
              />
            </div>
            <Button variant="primary" onClick={handleSavePrice} disabled={!selectedModel}>
              {t('common.save')}
            </Button>
          </div>
        </div>

        {/* Saved Prices List */}
        <div className={styles.pricesList}>
          <h4 className={styles.pricesTitle}>{t('usage_stats.saved_prices')}</h4>
          {savedPrices.length > 0 ? (
            <div className={styles.pricesGrid}>
              {savedPrices.map(([model, price]) => (
                <div key={model} className={styles.priceItem}>
                  <div className={styles.priceInfo}>
                    <span className={styles.priceModel}>{model}</span>
                    <div className={styles.priceMeta}>
                      <span>
                        {t('usage_stats.model_price_prompt')}: ${price.prompt.toFixed(4)}/1M
                      </span>
                      <span>
                        {t('usage_stats.model_price_completion')}: ${price.completion.toFixed(4)}/1M
                      </span>
                      <span>
                        {t('usage_stats.model_price_cache_read')}: ${(price.cacheRead ?? price.cache).toFixed(4)}/1M
                      </span>
                      <span>
                        {t('usage_stats.model_price_cache_creation')}: ${(price.cacheCreation ?? price.cacheRead ?? price.cache).toFixed(4)}/1M
                      </span>
                    </div>
                  </div>
                  <div className={styles.priceActions}>
                    <Button variant="secondary" size="sm" onClick={() => handleOpenEdit(model)}>
                      {t('common.edit')}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => handleDeletePrice(model)}>
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.hint}>{t('usage_stats.model_price_empty')}</div>
          )}
        </div>
      </div>

      {/* Edit Modal */}
      <Modal
        open={editModel !== null}
        title={editModel ?? ''}
        onClose={() => setEditModel(null)}
        footer={
          <div className={styles.priceActions}>
            <Button variant="secondary" onClick={() => setEditModel(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleSaveEdit}>
              {t('common.save')}
            </Button>
          </div>
        }
        width={420}
      >
        <div className={styles.editModalBody}>
          <div className={styles.formField}>
            <label>{t('usage_stats.model_price_prompt')} ($/1M)</label>
            <Input
              type="number"
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              placeholder="0.00"
              step="0.0001"
            />
          </div>
          <div className={styles.formField}>
            <label>{t('usage_stats.model_price_completion')} ($/1M)</label>
            <Input
              type="number"
              value={editCompletion}
              onChange={(e) => setEditCompletion(e.target.value)}
              placeholder="0.00"
              step="0.0001"
            />
          </div>
          <div className={styles.formField}>
            <label>{t('usage_stats.model_price_cache_read')} ($/1M)</label>
            <Input
              type="number"
              value={editCacheRead}
              onChange={(e) => setEditCacheRead(e.target.value)}
              placeholder="0.00"
              step="0.0001"
            />
          </div>
          <div className={styles.formField}>
            <label>{t('usage_stats.model_price_cache_creation')} ($/1M)</label>
            <Input
              type="number"
              value={editCacheCreation}
              onChange={(e) => setEditCacheCreation(e.target.value)}
              placeholder="0.00"
              step="0.0001"
            />
          </div>
        </div>
      </Modal>
    </Card>
  );
}
