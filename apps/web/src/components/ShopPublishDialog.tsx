import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { createOperationId } from '@ark-control/common';
import type { ShopPublishPreview } from '@ark-control/common';
import { useTranslation } from 'react-i18next';
import { request } from '@/api';

const sectionNames: Record<string, string> = {
  General: '常规设置',
  ShopItems: '商品',
  Kits: '礼包',
  SellItems: '回收',
};

export default function ShopPublishDialog({
  scopeId,
  revision,
  onClose,
  onPublished,
}: {
  scopeId: string;
  revision: number;
  onClose: () => void;
  onPublished: () => void;
}) {
  const { t } = useTranslation();
  const [review, setReview] = useState(() => ({
    preflightId: createOperationId(),
    publishId: createOperationId(),
    revision,
  }));
  const [preview, setPreview] = useState<ShopPublishPreview | null>(null);
  const [preflightError, setPreflightError] = useState('');
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (failure: unknown) => {
      if (!closed)
        setPreflightError(failure instanceof Error ? failure.message : t('发布预检失败。'));
    };
    const refresh = async () => {
      try {
        const result = await request<ShopPublishPreview>(
          `/management/shop/preflight/${review.preflightId}?${new URLSearchParams({ scopeId })}`,
        );
        if (closed) return;
        setPreview(result);
        if (result.pending) timer = setTimeout(() => void refresh(), 1500);
      } catch (failure) {
        fail(failure);
      }
    };
    void request('/management/shop/preflight', 'POST', {
      scopeId,
      revision: review.revision,
      idempotencyKey: review.preflightId,
    })
      .then(() => {
        if (!closed) void refresh();
      })
      .catch(fail);
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [review, scopeId, t]);

  function retry() {
    setPreview(null);
    setPreflightError('');
    setError('');
    setReview({ preflightId: createOperationId(), publishId: createOperationId(), revision });
  }

  const draftChanged = review.revision !== revision;
  const canConfirm =
    preview?.ready && !draftChanged && !!reason.trim() && !sending && !preflightError;
  async function publish(event: FormEvent) {
    event.preventDefault();
    if (!canConfirm) return;
    setSending(true);
    setError('');
    try {
      await request('/management/actions', 'POST', {
        scopeId,
        kind: 'shop-publish',
        reason: reason.trim(),
        revision: review.revision,
        preflightId: review.preflightId,
        idempotencyKey: review.publishId,
      });
      onPublished();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('发布失败。'));
      setSending(false);
    }
  }

  const loading = !preflightError && (!preview || preview.pending);
  return (
    <Dialog
      open
      onClose={sending ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="shop-publish-title"
      slotProps={{ paper: { component: 'form', onSubmit: publish } }}
    >
      <DialogTitle id="shop-publish-title">{t('发布商店')}</DialogTitle>
      <DialogContent dividers>
        <Stack gap={1.5}>
          <Typography variant="body2" color="text.secondary">
            {t('先读取各地图的 ArkShop 配置。确认发布后逐图备份，运行中的地图会重新加载商店。')}
          </Typography>
          {loading && <LinearProgress aria-label={t('正在读取主机配置')} />}
          {preflightError && <Alert severity="error">{preflightError}</Alert>}
          {(draftChanged || (preview && !preview.current)) && (
            <Alert severity="warning">{t('草稿或组内地图已变化，请重新预检。')}</Alert>
          )}
          {preview?.maps.map((map) => (
            <Stack key={map.id} gap={0.5} sx={{ borderBottom: 1, borderColor: 'divider', pb: 1 }}>
              <Typography fontWeight={600}>{map.name}</Typography>
              <Typography variant="body2" color={map.error ? 'error.main' : 'text.secondary'}>
                {map.error || (map.changes ? t('配置已读取') : t(map.progress))}
              </Typography>
              {map.changes?.map(({ section, added, modified, removed }) => (
                <Typography key={section} variant="body2">
                  {t(Object.hasOwn(sectionNames, section) ? sectionNames[section]! : section)}
                  {' · '}
                  {t('新增 {{added}}，修改 {{modified}}，移除 {{removed}}', {
                    added,
                    modified,
                    removed,
                  })}
                </Typography>
              ))}
              {!!revision && map.changes?.length === 0 && (
                <Typography variant="body2">{t('配置一致')}</Typography>
              )}
            </Stack>
          ))}
          {!revision && (
            <Alert severity="info">
              {t('保存商店草稿后即可发布。你可以从已读取的地图载入配置。')}
            </Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {!!revision && (
            <TextField
              label={t('发布说明')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              slotProps={{ htmlInput: { maxLength: 500 } }}
              disabled={sending}
              multiline
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onClose} disabled={sending}>
          {t('关闭')}
        </Button>
        <Button onClick={retry} disabled={loading || sending}>
          {t('重新预检')}
        </Button>
        <Button type="submit" variant="contained" disabled={!canConfirm}>
          {t('确认发布')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
