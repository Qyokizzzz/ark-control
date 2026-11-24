import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { ShopOrder, ShopOrderPage } from '@ark-control/common';
import { request } from '@/api';
import { useWorkspaceStore } from '@/store';
import { formatDate } from './common';
import type { FormValues } from './common';
import FormDialog from './FormDialog';
import Surface from './Surface';

const orderLabels: Record<ShopOrder['status'], string> = {
  pending: '待发货',
  delivered: '已发货',
  refunded: '已退币',
  uncertain: '待核实',
};

export default function IndependentOrders({
  scopeId,
  canResolve,
}: {
  scopeId: string;
  canResolve: boolean;
}) {
  const { t } = useTranslation();
  const instances = useWorkspaceStore((state) => state.data?.instances);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ShopOrderPage | null>(null);
  const [error, setError] = useState('');
  const [resolving, setResolving] = useState<ShopOrder | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ scopeId, page: String(page) });
    async function loadOrders() {
      try {
        const orders = await request<ShopOrderPage>(`/management/shop/orders?${query}`);
        if (active) {
          setResult(orders);
          setError('');
        }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : '加载订单失败。');
      }
    }
    void loadOrders();
    const timer = setInterval(() => void loadOrders(), 8000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [scopeId, page, refresh]);

  const handleResolve = useCallback(
    async (values: FormValues) => {
      if (!resolving) return;
      await request(`/management/shop/orders/${resolving.id}/resolve`, 'POST', values);
      setRefresh((value) => value + 1);
    },
    [resolving],
  );

  return (
    <Surface sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography variant="h5" sx={{ mb: 2 }}>
        {t('独立商店订单')}
      </Typography>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {!result && !error && <Typography color="text.secondary">{t('正在加载…')}</Typography>}
      {result && !result.entries.length && (
        <Typography color="text.secondary">{t('暂无订单。')}</Typography>
      )}
      {result?.entries.map((order) => (
        <Stack
          key={order.id}
          direction={{ xs: 'column', sm: 'row' }}
          gap={1}
          justifyContent="space-between"
          sx={{ py: 1.5, borderTop: 1, borderColor: 'divider' }}
        >
          <Box minWidth={0}>
            <Stack gap={1} direction="row" alignItems="center" flexWrap="wrap">
              <Typography fontWeight={650}>
                {order.name} ×{order.quantity} · {order.total} {t('金币')}
              </Typography>
              <Chip
                size="small"
                color={
                  order.status === 'uncertain'
                    ? 'warning'
                    : order.status === 'delivered'
                      ? 'success'
                      : 'default'
                }
                label={t(orderLabels[order.status])}
              />
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              {order.steamId} ·{' '}
              {instances?.find(({ id }) => id === order.instanceId)?.name ?? order.instanceId} ·{' '}
              {formatDate(order.createdAt)}
              <br />
              {order.id}
              {order.reason && ` · ${order.reason}`}
            </Typography>
          </Box>
          {canResolve && order.status === 'uncertain' && (
            <Button
              size="small"
              sx={{ alignSelf: 'flex-start', flexShrink: 0 }}
              onClick={() => setResolving(order)}
            >
              {t('核实结果')}
            </Button>
          )}
        </Stack>
      ))}
      {(page > 1 || result?.hasMore) && (
        <Stack direction="row" alignItems="center" gap={1} sx={{ mt: 2 }}>
          <Button
            disabled={page <= 1 || result?.page !== page}
            onClick={() => setPage((value) => value - 1)}
          >
            {t('上一页')}
          </Button>
          <Typography variant="body2">{page}</Typography>
          <Button
            disabled={!result?.hasMore || result.page !== page}
            onClick={() => setPage((value) => value + 1)}
          >
            {t('下一页')}
          </Button>
        </Stack>
      )}
      {resolving && (
        <FormDialog
          title="核实订单"
          description="先核对玩家背包、恐龙或游戏记录。确认完全未发货时，后台返还本单金币。"
          fields={[
            {
              key: 'outcome',
              label: '核实结果',
              kind: 'select',
              required: true,
              options: [
                { value: 'delivered', label: '确认已发货' },
                { value: 'failed', label: '确认完全未发货并退币' },
              ],
            },
            {
              key: 'evidence',
              label: '核实依据',
              kind: 'textarea',
              required: true,
              maxLength: 500,
            },
          ]}
          initial={{ outcome: '', evidence: '' }}
          onClose={() => setResolving(null)}
          onSubmit={handleResolve}
        />
      )}
    </Surface>
  );
}
