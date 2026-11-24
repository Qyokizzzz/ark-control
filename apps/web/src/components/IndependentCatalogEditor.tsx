import { useCallback, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { independentProductSchema } from '@ark-control/common';
import type { IndependentProduct } from '@ark-control/common';
import { request } from '@/api';
import { useManagementStore, useUiStore } from '@/store';
import type { FormValues } from './common';
import ConfirmDialog from './ConfirmDialog';
import FormDialog from './FormDialog';
import Surface from './Surface';

const itemExample = [
  {
    kind: 'item',
    blueprint:
      "Blueprint'/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Stone.PrimalItemResource_Stone'",
    amount: 50,
    quality: 0,
    blueprintOnly: false,
  },
];

type ProductEdit = { revision: number; product?: IndependentProduct; remove?: boolean };

export default function IndependentCatalogEditor({
  scopeId,
  canEdit,
}: {
  scopeId: string;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const catalog = useManagementStore((state) => state.data?.independentCatalog);
  const load = useManagementStore((state) => state.load);
  const notify = useUiStore((state) => state.notify);
  const [edit, setEdit] = useState<ProductEdit | null>(null);
  const revision = catalog?.revision ?? 0;
  const product = edit?.product;
  const handleClose = useCallback(() => setEdit(null), []);
  const handleEdit = useCallback(
    (product?: IndependentProduct, remove = false) => {
      setEdit({ revision, product, remove });
    },
    [revision],
  );
  const handleSave = useCallback(
    async (values: FormValues) => {
      if (!edit) return;
      if (revision !== edit.revision) throw new Error('商品已被其他页面修改，请重新打开编辑。');
      const products = catalog?.products ?? [];
      let next = products.filter(({ id }) => id !== edit.product?.id);
      if (!edit.remove) {
        const rawDelivery: unknown = JSON.parse(String(values.delivery));
        const parsed = independentProductSchema.safeParse({
          id: String(values.id).trim(),
          name: values.name,
          price: Number(values.price),
          vipPrice: values.vipPrice === '' ? null : Number(values.vipPrice),
          limitPerPlayer: values.limit === '' ? null : Number(values.limit),
          enabled: values.enabled,
          delivery: rawDelivery,
        });
        if (!parsed.success)
          throw new Error(
            parsed.error.issues
              .map(({ path, message }) => `${path.join('.')} · ${message}`)
              .join('\n'),
          );
        if (next.some(({ id }) => id === parsed.data.id)) throw new Error('商品编号已存在。');
        next = edit.product
          ? products.map((existing) => (existing.id === edit.product!.id ? parsed.data : existing))
          : [...products, parsed.data];
      }
      await request('/management/shop/catalog', 'POST', {
        scopeId,
        revision: edit.revision,
        products: next,
      });
      await load();
      notify(t(edit.remove ? '商品已删除。' : '商品已保存，组内生效。'));
    },
    [catalog, edit, load, notify, revision, scopeId, t],
  );

  return (
    <Stack gap={2}>
      <Alert severity="info">
        {t(
          '游戏内用 /as shop 查看商品、/as points 查金币、/as buy 商品编号 数量 购买。金币和 VIP 在用户管理中发放。',
        )}
      </Alert>
      <Surface sx={{ p: { xs: 2, sm: 3 } }}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          gap={1}
          sx={{ mb: 2 }}
        >
          <Typography variant="h5">{t('独立商店商品')}</Typography>
          {canEdit && (
            <Button variant="contained" onClick={() => handleEdit()}>
              {t('新增商品')}
            </Button>
          )}
        </Stack>
        {!catalog?.products.length && (
          <Typography color="text.secondary">{t('暂无商品。')}</Typography>
        )}
        {catalog?.products.map((entry) => (
          <Stack
            key={entry.id}
            direction={{ xs: 'column', sm: 'row' }}
            gap={1}
            justifyContent="space-between"
            sx={{ py: 1.75, borderTop: 1, borderColor: 'divider' }}
          >
            <Box minWidth={0}>
              <Stack gap={1} direction="row" alignItems="center" flexWrap="wrap">
                <Typography fontWeight={650} sx={{ overflowWrap: 'anywhere' }}>
                  {entry.name}
                </Typography>
                {!entry.enabled && <Chip size="small" label={t('已下架')} />}
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                {entry.id} · {entry.price} {t('金币')}
                {entry.vipPrice !== null && ` · VIP ${entry.vipPrice} ${t('金币')}`}
                {entry.limitPerPlayer !== null && ` · ${t('每人限购')} ${entry.limitPerPlayer}`}
              </Typography>
            </Box>
            {canEdit && (
              <Stack direction="row" alignItems="flex-start">
                <Button size="small" onClick={() => handleEdit(entry)}>
                  {t('编辑')}
                </Button>
                <Button size="small" color="error" onClick={() => handleEdit(entry, true)}>
                  {t('删除')}
                </Button>
              </Stack>
            )}
          </Stack>
        ))}
      </Surface>
      {edit?.remove && product ? (
        <ConfirmDialog
          title="删除商品"
          message={`从独立商店删除「${product.name}」。已有订单仍可查询。`}
          destructive
          onClose={handleClose}
          onConfirm={() => handleSave({})}
        />
      ) : (
        edit && (
          <FormDialog
            title={product ? '编辑商品' : '新增商品'}
            fields={[
              { key: 'id', label: '商品编号', required: true, disabled: !!product, maxLength: 80 },
              { key: 'name', label: '商品名称', required: true, maxLength: 80 },
              {
                key: 'price',
                label: '普通售价（金币）',
                kind: 'number',
                required: true,
                min: 1,
                max: 100000000,
                step: '1',
              },
              {
                key: 'vipPrice',
                label: 'VIP 售价（金币）',
                kind: 'number',
                min: 0,
                max: 100000000,
                step: '1',
                helper: '留空沿用普通售价。',
              },
              {
                key: 'limit',
                label: '每人累计限购（份）',
                kind: 'number',
                min: 1,
                max: 1000000,
                step: '1',
                helper: '留空不限购。',
              },
              { key: 'enabled', label: '上架商品', kind: 'switch' },
              {
                key: 'delivery',
                label: '发放内容（JSON）',
                kind: 'textarea',
                required: true,
                helper:
                  '填写数组。物品用 item、blueprint、amount 和 quality。恐龙用 dino、blueprint 和 level。',
              },
            ]}
            initial={{
              id: product?.id ?? '',
              name: product?.name ?? '',
              price: String(product?.price ?? 100),
              vipPrice: product?.vipPrice?.toString() ?? '',
              limit: product?.limitPerPlayer?.toString() ?? '',
              enabled: product?.enabled ?? true,
              delivery: JSON.stringify(product?.delivery ?? itemExample, null, 2),
            }}
            onClose={handleClose}
            onSubmit={handleSave}
          />
        )
      )}
    </Stack>
  );
}
