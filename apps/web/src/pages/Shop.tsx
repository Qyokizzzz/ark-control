import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { InfoIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { instanceTarget, publicShopConfig, validateShopConfig } from '@ark-control/common';
import type { Json, ShopMode } from '@ark-control/common';
import { request } from '@/api';
import { useManagementStore, useUiStore, useWorkspaceStore } from '@/store';
import {
  ConfirmDialog,
  FormDialog,
  IndependentCatalogEditor,
  IndependentOrders,
  ManagementScope,
  PageHeading,
  ShopPublishDialog,
  Surface,
  formatDate,
} from '@/components';
import type { FormValues } from '@/components';
import { useWorkspaceCan } from '@/store/workspace-selection';

export default function Shop() {
  const { t } = useTranslation();
  const { data, scopeId, error, dirty, load } = useManagementStore();
  const instances = useWorkspaceStore((state) => state.data?.instances);
  const can = useWorkspaceCan();
  const notify = useUiStore((state) => state.notify);
  const [next, setNext] = useState<ShopMode | null>(null);
  const [showOrders, setShowOrders] = useState(false);
  const mode = data?.shopMode;
  const instance = instances?.find(({ id }) => scopeId === `instance:${id}`);
  const target = scopeId.startsWith('cluster:')
    ? { kind: 'cluster' as const, clusterId: scopeId.slice(8) }
    : instance
      ? instanceTarget(instance)
      : { kind: 'map' as const, instanceId: scopeId.slice(9) };
  const canEdit = !!scopeId && can('shop.write', target);
  const canReadOrders =
    !!scopeId && (can('commerce.read', target) || can('commerce.write', target));
  const canResolveOrders = !!scopeId && can('commerce.write', target);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);
  const handleModeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    if (value === 'arkshop' || value === 'independent') setNext(value);
  }, []);
  const handleCloseMode = useCallback(() => setNext(null), []);
  const handleSwitchMode = useCallback(async () => {
    if (!next) return;
    await request('/management/shop/mode', 'POST', { scopeId, mode: next });
    await load();
    setShowOrders(false);
    notify(t('商店模式已切换。'));
  }, [load, next, notify, scopeId, t]);

  return (
    <>
      <PageHeading title="商店管理" description="按互通组管理游戏内商店。" />
      <ManagementScope
        secondaryField={
          mode && (
            <TextField
              select
              fullWidth
              label={t('商店模式')}
              value={mode}
              onChange={handleModeChange}
              disabled={!canEdit}
              helperText={
                canEdit
                  ? t(dirty ? '保存或放弃草稿后可切换。' : '切换前请停止组内地图。')
                  : undefined
              }
            >
              <MenuItem value="arkshop">ArkShop</MenuItem>
              <MenuItem value="independent">{t('独立商店')}</MenuItem>
            </TextField>
          )
        }
        action={
          mode &&
          canReadOrders && (
            <Button variant="outlined" fullWidth onClick={() => setShowOrders((value) => !value)}>
              {t(showOrders ? '返回商品管理' : '独立商店订单')}
            </Button>
          )
        }
      />
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {mode && (
        <>
          {!(showOrders && canReadOrders) && scopeId && (
            <Alert
              icon={<InfoIcon size={18} />}
              severity="info"
              sx={{ mb: 3 }}
              action={
                <Button
                  component={Link}
                  to={`/instances/plugins?${new URLSearchParams({ scopeId })}`}
                  size="small"
                  color="inherit"
                  sx={{ whiteSpace: 'nowrap' }}
                >
                  {t('安装依赖')}
                </Button>
              }
            >
              {t(
                mode === 'arkshop'
                  ? '发布前，请在目标地图安装 ASE ArkApi、Permissions 和 ArkShop。'
                  : '使用游戏内商店前，请在目标地图安装 ASE ArkApi 和独立商店插件。',
              )}
            </Alert>
          )}
          {showOrders && canReadOrders ? (
            <IndependentOrders key={scopeId} scopeId={scopeId} canResolve={canResolveOrders} />
          ) : mode === 'independent' ? (
            <IndependentCatalogEditor key={scopeId} scopeId={scopeId} canEdit={canEdit} />
          ) : (
            <ArkShopEditor key={scopeId} canEdit={canEdit} />
          )}
        </>
      )}
      {next && (
        <ConfirmDialog
          title="切换商店模式"
          message={
            next === 'independent'
              ? '切换后独立商店使用后台的商品、金币和 VIP。请在组内每张地图安装独立商店插件，并将 ArkShop 插件移出 Plugins 目录。'
              : '切换后玩家使用 ArkShop 的购买指令、商品和金币。请确认组内地图已配置 ArkShop。'
          }
          onClose={handleCloseMode}
          onConfirm={handleSwitchMode}
        />
      )}
    </>
  );
}

const categories = ['ShopItems', 'Kits', 'SellItems'] as const;
const labels: Record<string, string> = { ShopItems: '商品', Kits: '礼包', SellItems: '回收' };
const sample = JSON.stringify(
  {
    Type: 'item',
    Items: [
      {
        Amount: 1,
        Quality: 0,
        ForceBlueprint: false,
        Blueprint:
          "Blueprint'/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Stone.PrimalItemResource_Stone'",
      },
    ],
  },
  null,
  2,
);
function parseConfig(text: string): Record<string, Json> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('商店配置必须是 JSON 对象。');
  return publicShopConfig(value as Record<string, Json>);
}
type Edit = { category: string; id: string; value: Record<string, Json> } | 'new' | null;
function ArkShopEditor({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const { data, scopeId, draftText, draftRevision, dirty, load, setDraft, saveDraft, resetDraft } =
    useManagementStore();
  const workspace = useWorkspaceStore((state) => state.data);
  const notify = useUiStore((state) => state.notify);
  const [edit, setEdit] = useState<Edit>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [publishing, setPublishing] = useState(false);
  let config: Record<string, Json> = {};
  let parseError = '';
  try {
    config = parseConfig(draftText || '{}');
    parseError = validateShopConfig(config).join('\n');
  } catch (failure) {
    parseError = failure instanceof Error ? failure.message : t('配置无效。');
  }
  const close = useCallback(() => setEdit(null), []);
  const add = useCallback(() => setEdit('new'), []);
  const change = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    [setDraft],
  );
  const importClick = useCallback(() => fileRef.current?.click(), []);
  const importFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        if (file.size > 1000000) throw new Error(t('配置文件不能超过 1 MB。'));
        const input = parseConfig(await file.text());
        const errors = validateShopConfig(input);
        if (errors.length) throw new Error(errors.join('\n'));
        setDraft(JSON.stringify(input, null, 2));
        notify(t('已导入草稿，请核对后保存。'));
      } catch (failure) {
        notify(failure instanceof Error ? failure.message : t('导入失败。'), 'error');
      } finally {
        event.target.value = '';
      }
    },
    [setDraft, notify, t],
  );
  const exportFile = useCallback(() => {
    try {
      const safe = parseConfig(draftText);
      const blob = new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ArkShop.config.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : t('导出失败。'), 'error');
    }
  }, [draftText, notify, t]);
  const save = useCallback(async () => {
    setBusy(true);
    try {
      await saveDraft();
      notify(t('商店草稿已保存。'));
    } catch (failure) {
      notify(failure instanceof Error ? failure.message : t('保存失败。'), 'error');
    } finally {
      setBusy(false);
    }
  }, [saveDraft, notify, t]);
  const openItem = useCallback(
    (category: string, id: string, value: Record<string, Json>) => setEdit({ category, id, value }),
    [],
  );
  const loadHostConfig = useCallback(
    (config: Record<string, Json>) => setDraft(JSON.stringify(config, null, 2)),
    [setDraft],
  );
  const removeItem = useCallback(
    (category: string, id: string) => {
      const draft = parseConfig(draftText);
      const section = draft[category];
      if (section && typeof section === 'object' && !Array.isArray(section)) {
        delete section[id];
        setDraft(JSON.stringify(draft, null, 2));
      }
    },
    [draftText, setDraft],
  );
  const submit = useCallback(
    async (values: FormValues) => {
      const draft = parseConfig(draftText);
      const category = String(values.category);
      const id = String(values.id).trim();
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
        throw new Error(t('商品 ID 只能使用字母、数字、下划线和短横线。'));
      const section =
        draft[category] && typeof draft[category] === 'object' && !Array.isArray(draft[category])
          ? (draft[category] as Record<string, Json>)
          : {};
      if ((edit === 'new' || (typeof edit === 'object' && edit?.id !== id)) && section[id])
        throw new Error(t('商品 ID 已存在。'));
      const value: unknown = JSON.parse(String(values.definition));
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(t('商品定义必须是 JSON 对象。'));
      const item = {
        ...value,
        Description: String(values.description),
        Price: Number(values.price),
      };
      if (edit && typeof edit === 'object' && (edit.id !== id || edit.category !== category)) {
        const previous = draft[edit.category];
        if (previous && typeof previous === 'object' && !Array.isArray(previous))
          delete previous[edit.id];
      }
      section[id] = item;
      draft[category] = section;
      const errors = validateShopConfig(draft);
      if (errors.length) throw new Error(errors.join('\n'));
      setDraft(JSON.stringify(draft, null, 2));
    },
    [edit, t, draftText, setDraft],
  );
  const current = edit && typeof edit === 'object' ? edit : null;
  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {t('数据库和通知凭据保留在游戏主机，编辑和导出的 JSON 会隐藏这些字段。')}
      </Typography>
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center" sx={{ mb: 3 }}>
        <Chip label={`${t('草稿版本')} ${draftRevision}${dirty ? ' · ' + t('未保存') : ''}`} />
        <Chip label={`${t('已发布版本')} ${data?.shop?.publishedRevision ?? '—'}`} />
        <Button disabled={!canEdit} onClick={importClick}>
          {t('导入 JSON')}
        </Button>
        <Button onClick={exportFile}>{t('导出 JSON')}</Button>
        <Button disabled={!dirty} onClick={resetDraft}>
          {t('放弃草稿修改')}
        </Button>
        <Button disabled={!canEdit || busy || !scopeId || !!parseError} onClick={() => void save()}>
          {t('保存草稿')}
        </Button>
        <Button
          variant="contained"
          disabled={!canEdit || busy || dirty || !scopeId || !!parseError}
          onClick={() => setPublishing(true)}
        >
          {t('发布到组内地图')}
        </Button>
        <input
          type="file"
          accept="application/json,.json"
          ref={fileRef}
          hidden
          onChange={(event) => void importFile(event)}
        />
      </Stack>
      {data?.links.map((link) => (
        <Alert
          key={link.id}
          severity={link.shopDatabase ? 'success' : 'info'}
          sx={{ mb: 1 }}
          action={
            <Button
              size="small"
              disabled={!canEdit || dirty}
              onClick={() => loadHostConfig(link.config)}
            >
              {t('载入此配置到草稿')}
            </Button>
          }
        >
          {workspace?.instances.find((instance) => instance.id === link.id)?.name ?? link.id} ·{' '}
          {t(link.shopDatabase ? '已读取共享数据库配置' : '未确认共享数据库')} ·{' '}
          {formatDate(link.checkedAt)}
        </Alert>
      ))}
      {parseError && (
        <Alert severity="error" sx={{ my: 2, whiteSpace: 'pre-wrap' }}>
          {parseError}
        </Alert>
      )}
      <Stack gap={3} sx={{ mt: 3 }}>
        {categories.map((category) => {
          const entries = config[category];
          return (
            <Surface key={category}>
              <Box sx={{ p: 3 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="h5">{t(labels[category]!)}</Typography>
                  <Button onClick={add} disabled={!canEdit || !!parseError}>
                    {t('新增条目')}
                  </Button>
                </Stack>
                {entries &&
                  typeof entries === 'object' &&
                  !Array.isArray(entries) &&
                  Object.entries(entries).map(([id, value]) =>
                    value && typeof value === 'object' && !Array.isArray(value) ? (
                      <Box key={id} sx={{ pt: 2 }}>
                        <Divider sx={{ mb: 2 }} />
                        <Stack
                          direction={{ xs: 'column', sm: 'row' }}
                          justifyContent="space-between"
                          gap={1}
                        >
                          <Box>
                            <Typography fontWeight={650}>
                              {String(value.Description || id)}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              {id} · {t('价格')} {String(value.Price ?? '—')} ·{' '}
                              {String(value.Type ?? category)}
                            </Typography>
                          </Box>
                          <Stack direction="row">
                            <Button
                              size="small"
                              disabled={!canEdit}
                              onClick={() => openItem(category, id, value)}
                            >
                              {t('编辑')}
                            </Button>
                            <Button
                              size="small"
                              color="error"
                              disabled={!canEdit}
                              onClick={() => removeItem(category, id)}
                            >
                              {t('删除草稿条目')}
                            </Button>
                          </Stack>
                        </Stack>
                      </Box>
                    ) : null,
                  )}
              </Box>
            </Surface>
          );
        })}
        <Surface>
          <Box sx={{ p: 3 }}>
            <Typography variant="h5" sx={{ mb: 2 }}>
              {t('完整配置')}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t('商品的物品蓝图、指令、礼包权限及定时奖励可在这里编辑，未知字段会保留。')}
            </Typography>
            <TextField
              label="ArkShop JSON"
              multiline
              minRows={12}
              maxRows={28}
              fullWidth
              disabled={!canEdit}
              value={draftText}
              onChange={change}
              slotProps={{ htmlInput: { spellCheck: false } }}
              sx={{ '& textarea': { fontFamily: 'monospace', fontSize: 13 } }}
            />
          </Box>
        </Surface>
      </Stack>
      {publishing && (
        <ShopPublishDialog
          scopeId={scopeId}
          revision={draftRevision}
          onClose={() => {
            setPublishing(false);
            void load();
          }}
          onPublished={() => {
            setPublishing(false);
            void load();
            notify(t('发布任务已提交，每张地图会分别返回执行结果。'));
          }}
        />
      )}
      {edit && (
        <FormDialog
          title={current ? '编辑条目' : '新增条目'}
          fields={[
            {
              key: 'category',
              label: '类别',
              kind: 'select',
              required: true,
              options: categories.map((value) => ({ value, label: labels[value]! })),
            },
            { key: 'id', label: '条目 ID', required: true },
            { key: 'description', label: '描述', required: true },
            {
              key: 'price',
              label: '价格',
              kind: 'number',
              min: 0,
              step: '1',
              required: true,
            },
            {
              key: 'definition',
              label: '发放内容与其他字段（JSON）',
              kind: 'textarea',
              required: true,
              helper: '保留 Type、Items、Dinos、Commands、Permissions 等实际插件字段。',
            },
          ]}
          initial={{
            category: current?.category ?? 'ShopItems',
            id: current?.id ?? '',
            description: String(current?.value.Description ?? ''),
            price: String(current?.value.Price ?? 100),
            definition: current
              ? JSON.stringify(
                  Object.fromEntries(
                    Object.entries(current.value).filter(
                      ([key]) => !['Description', 'Price'].includes(key),
                    ),
                  ),
                  null,
                  2,
                )
              : sample,
          }}
          onClose={close}
          onSubmit={submit}
          submitLabel="写入草稿"
        />
      )}
    </>
  );
}
