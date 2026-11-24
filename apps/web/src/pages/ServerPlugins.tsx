import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControlLabel,
  LinearProgress,
  Link as MuiLink,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { ArrowLeftIcon, ArrowSquareOutIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  ARKSHOP_UI_WORKSHOP_ID,
  createOperationId,
  PLUGIN_ARCHIVE_LIMIT,
  pluginIdSchema,
  requiredPlugins,
  serverPlugins,
  shopPluginIds,
} from '@ark-control/common';
import type {
  GameBranch,
  PluginInstallRequest,
  PluginMap,
  ServerPluginId,
  ServerPluginsView,
} from '@ark-control/common';
import { http, request } from '@/api';
import { Empty, PageHeading, Status, Surface, formatDate } from '@/components';
import { useWorkspaceSelection } from '@/store/workspace-selection';

const branches: Record<GameBranch, string> = {
  public: '公开分支 · 361',
  preaquatica: 'preaquatica · 358',
};
const taskActive = (status: string) =>
  ['queued', 'leased', 'executing', 'cancelling'].includes(status);

function pluginStatus(map: PluginMap, id: ServerPluginId) {
  if (!map.report) return { label: '待检测', color: 'default' } as const;
  if (map.report.loaded?.includes(id)) return { label: 'DLL 已加载', color: 'success' } as const;
  if (!map.report.installed.includes(id)) return { label: '未安装', color: 'default' } as const;
  if (!map.running) return { label: '已安装，待启动验证', color: 'info' } as const;
  if (map.report.loaded === null) return { label: '已安装，待检测加载', color: 'info' } as const;
  return { label: '已安装，未检测到加载', color: 'warning' } as const;
}

function PluginMapRow({
  map,
  plugins,
  checked,
  busy,
  onToggle,
}: {
  map: PluginMap;
  plugins: ServerPluginId[];
  checked: boolean;
  busy: boolean;
  onToggle: (id: string, checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Box
      component="li"
      sx={{ listStyle: 'none', py: 1.75, '& + li': { borderTop: 1, borderColor: 'divider' } }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
        <Box sx={{ minWidth: 0 }}>
          <FormControlLabel
            sx={{
              m: 0,
              alignItems: 'flex-start',
              '& .MuiFormControlLabel-label': {
                overflowWrap: 'anywhere',
                pt: 0.65,
                fontWeight: 650,
              },
            }}
            control={
              <Checkbox
                size="small"
                checked={checked}
                disabled={busy || !!map.blocked}
                onChange={(_, next) => onToggle(map.id, next)}
              />
            }
            label={map.name}
          />
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ ml: 4.5, overflowWrap: 'anywhere' }}
          >
            {map.hostName} · {t(branches[map.branch])}
          </Typography>
        </Box>
        {map.task && <Status value={map.task.status} />}
      </Stack>
      <Stack sx={{ ml: { xs: 0, sm: 4.5 }, mt: 1 }} gap={1} aria-label={t('插件状态')}>
        <Stack direction="row" flexWrap="wrap" gap={0.75}>
          {pluginIdSchema.options
            .filter((id) => plugins.includes(id) || map.report?.installed.includes(id))
            .map((id) => {
              const { label, color } = pluginStatus(map, id);
              return (
                <Chip
                  key={id}
                  size="small"
                  variant="outlined"
                  color={color}
                  label={`${t(serverPlugins[id].name)} · ${t(label)}`}
                />
              );
            })}
        </Stack>
        {map.task && (
          <Box role="status">
            {taskActive(map.task.status) && <LinearProgress sx={{ mb: 0.5 }} />}
            <Typography
              variant="body2"
              color={map.task.error ? 'error.main' : 'text.secondary'}
              sx={{ overflowWrap: 'anywhere' }}
            >
              {map.task.error ?? map.task.progress}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {formatDate(map.task.createdAt)}
            </Typography>
          </Box>
        )}
        {map.blocked && (
          <Typography variant="body2" color="text.secondary">
            {t(map.blocked)}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

function PluginInstallation({
  data,
  scope,
  refresh,
}: {
  data: ServerPluginsView;
  scope: ServerPluginsView['scopes'][number];
  refresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [deselected, setDeselected] = useState<string[]>([]);
  const [selection, setSelection] = useState<ServerPluginId[]>(() => shopPluginIds(scope.mode));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const attempt = useRef({ key: '', fingerprint: '' });
  const maps = data.maps.filter(({ scopeId }) => scope.id === scopeId);
  const pluginIds = requiredPlugins(selection);
  const installMaps = maps.map((map) =>
    pluginIds.includes('arkshop-ui') && !map.arkShopUiSupported && !map.blocked
      ? { ...map, blocked: '请更新并重启主机助手以安装 ArkShopUI' }
      : map,
  );
  const eligible = installMaps.filter((map) => !map.blocked);
  const selected = eligible.filter(({ id }) => !deselected.includes(id));
  const branchList = [...new Set(maps.map(({ branch }) => branch))];
  const allowedIds = pluginIdSchema.options.filter((id) =>
    scope.mode === 'arkshop' ? id !== 'ark-control-shop' : !['arkshop', 'arkshop-ui'].includes(id),
  );
  const archive = (branch: GameBranch, pluginId: ServerPluginId) =>
    data.packages.find((item) => item.branch === branch && item.pluginId === pluginId);
  const missing = [
    ...new Set(
      selected.flatMap((map) =>
        pluginIds
          .filter(
            (id) =>
              !map.report?.installed.includes(id) &&
              (id === 'ark-control-shop' ? !data.builtinShop : !archive(map.branch, id)),
          )
          .map((id) => `${t(serverPlugins[id].name)} · ${t(branches[map.branch])}`),
      ),
    ),
  ];
  const toggleMap = (id: string, checked: boolean) =>
    setDeselected((current) =>
      checked ? current.filter((item) => item !== id) : [...current, id],
    );
  const togglePlugin = (id: ServerPluginId, checked: boolean) => {
    setSelection((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
    setError('');
    setNotice('');
  };

  async function upload(branch: GameBranch, id: ServerPluginId, file: File) {
    setError('');
    setNotice('');
    if (file.size > PLUGIN_ARCHIVE_LIMIT || !/\.zip$/i.test(file.name)) {
      setError(t('请选择不超过 64 MiB 的 ZIP。'));
      return;
    }
    setUploading(`${branch}:${id}`);
    try {
      const query = new URLSearchParams({ name: file.name });
      await http.post(`/server-plugins/packages/${branch}/${id}?${query}`, file, {
        headers: { 'Content-Type': 'application/octet-stream' },
        timeout: 300000,
      });
      await refresh();
      setNotice(t('已导入 {{plugin}}。', { plugin: t(serverPlugins[id].name) }));
    } catch (error) {
      setError(error instanceof Error ? error.message : t('导入安装包失败。'));
    } finally {
      setUploading('');
    }
  }

  async function install() {
    const mapIds = selected.map(({ id }) => id).sort();
    const fingerprint = JSON.stringify([scope.id, mapIds, pluginIds]);
    if (attempt.current.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: createOperationId() };
    const input: PluginInstallRequest = {
      scopeId: scope.id,
      mapIds,
      pluginIds,
      idempotencyKey: attempt.current.key,
    };
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { commandIds } = await request<{ commandIds: string[] }>(
        '/server-plugins/install',
        'POST',
        input,
      );
      attempt.current = { key: '', fingerprint: '' };
      setNotice(t('已提交 {{count}} 张地图的安装任务。', { count: commandIds.length }));
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : t('无法提交安装任务。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap={2}>
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1.2fr) minmax(0, 1fr)' },
          gap: 2,
          alignItems: 'start',
        }}
      >
        <Surface sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            gap={1}
            flexWrap="wrap"
          >
            <Typography variant="h4">{t('目标地图')}</Typography>
            <FormControlLabel
              sx={{ m: 0 }}
              control={
                <Checkbox
                  size="small"
                  checked={!!eligible.length && selected.length === eligible.length}
                  indeterminate={selected.length > 0 && selected.length < eligible.length}
                  disabled={busy || !eligible.length}
                  onChange={(_, checked) =>
                    setDeselected(checked ? [] : eligible.map(({ id }) => id))
                  }
                />
              }
              label={t('全选可安装地图')}
            />
          </Stack>
          <Box component="ul" sx={{ p: 0, mt: 0, mb: 2 }}>
            {installMaps.map((map) => (
              <PluginMapRow
                key={map.id}
                map={map}
                plugins={pluginIds}
                checked={
                  (!map.blocked || (!!map.task && taskActive(map.task.status))) &&
                  !deselected.includes(map.id)
                }
                busy={busy}
                onToggle={toggleMap}
              />
            ))}
          </Box>
          {missing.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              {t('请先导入所选地图需要的安装包。')} {missing.join('、')}
            </Alert>
          )}
          <Button
            variant="contained"
            fullWidth
            disabled={
              busy || !!uploading || !selected.length || !pluginIds.length || !!missing.length
            }
            onClick={() => void install()}
          >
            {t('为 {{count}} 张地图安装', { count: selected.length })}
          </Button>
        </Surface>
        <Surface sx={{ p: { xs: 2, sm: 3 } }}>
          <Typography variant="h4" sx={{ mb: 1 }}>
            {t('常用服务端插件')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('按游戏分支导入官方 ZIP。已有插件和配置会保留，启动地图后检查加载状态。')}
          </Typography>
          <Stack divider={<Divider />}>
            {allowedIds.map((id) => {
              const plugin = serverPlugins[id];
              return (
                <Box key={id} sx={{ py: 1.5 }}>
                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    flexWrap="wrap"
                    gap={1}
                  >
                    <FormControlLabel
                      sx={{ m: 0 }}
                      control={
                        <Checkbox
                          size="small"
                          checked={pluginIds.includes(id)}
                          disabled={
                            busy ||
                            (pluginIds.includes(id) &&
                              requiredPlugins(selection.filter((item) => item !== id)).includes(id))
                          }
                          onChange={(_, checked) => togglePlugin(id, checked)}
                        />
                      }
                      label={t(plugin.name)}
                    />
                    {plugin.officialUrl && (
                      <MuiLink
                        href={plugin.officialUrl}
                        target="_blank"
                        rel="noreferrer"
                        variant="body2"
                        sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
                      >
                        {t('官方下载')} <ArrowSquareOutIcon size={14} aria-hidden />
                      </MuiLink>
                    )}
                  </Stack>
                  <Stack gap={0.75} sx={{ ml: 4.5, mt: 0.5 }}>
                    {id === 'arkshop-ui' && (
                      <Typography variant="body2" color="text.secondary">
                        {t(
                          '需要 ASE ArkApi 3.51+、官方 ArkShop 3.02+ 和 Visual C++ 2022 运行库。请在目标地图启用创意工坊模组。',
                        )}{' '}
                        <MuiLink
                          href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${ARKSHOP_UI_WORKSHOP_ID}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          MX-E Ark Shop UI ({ARKSHOP_UI_WORKSHOP_ID})
                        </MuiLink>
                      </Typography>
                    )}
                    {id === 'ark-control-shop' ? (
                      <Typography
                        variant="body2"
                        color={data.builtinShop ? 'text.secondary' : 'error.main'}
                      >
                        {t(data.builtinShop ? '后台自带安装包' : '后台缺少独立商店安装包')}
                      </Typography>
                    ) : (
                      branchList.map((branch) => {
                        const imported = archive(branch, id);
                        const uploadingThis = uploading === `${branch}:${id}`;
                        return (
                          <Stack
                            key={branch}
                            direction={{ xs: 'column', sm: 'row', lg: 'column', xl: 'row' }}
                            alignItems={{ sm: 'flex-start', xl: 'center' }}
                            justifyContent="space-between"
                            gap={0.75}
                          >
                            <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                              <Typography variant="body2">{t(branches[branch])}</Typography>
                              <Typography
                                variant="caption"
                                color="text.secondary"
                                title={imported?.name}
                              >
                                {imported?.name ?? t('尚未导入 ZIP')}
                              </Typography>
                            </Box>
                            {data.canUpload && (
                              <Button
                                component="label"
                                size="small"
                                disabled={busy || !!uploading}
                                startIcon={<UploadSimpleIcon size={15} />}
                              >
                                {t(uploadingThis ? '正在导入' : imported ? '更换 ZIP' : '导入 ZIP')}
                                <input
                                  type="file"
                                  hidden
                                  accept=".zip,application/zip"
                                  disabled={busy || !!uploading}
                                  aria-label={`${t(plugin.name)} ${t(branches[branch])} ${t('导入 ZIP')}`}
                                  onChange={(event) => {
                                    const file = event.currentTarget.files?.[0];
                                    event.currentTarget.value = '';
                                    if (file) void upload(branch, id, file);
                                  }}
                                />
                              </Button>
                            )}
                          </Stack>
                        );
                      })
                    )}
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        </Surface>
      </Box>
    </Stack>
  );
}

function PluginWorkspace() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<ServerPluginsView | null>(null);
  const [error, setError] = useState('');
  const requestNumber = useRef(0);
  const refresh = useCallback(async () => {
    const number = ++requestNumber.current;
    try {
      const next = await request<ServerPluginsView>('/server-plugins');
      if (number !== requestNumber.current) return;
      setData(next);
      setError('');
    } catch (error) {
      if (number === requestNumber.current)
        setError(error instanceof Error ? error.message : '无法读取插件状态。');
    }
  }, []);
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);
  const chosen = params.get('scopeId');
  const scope = data?.scopes.find((item) => item.id === chosen) ?? data?.scopes[0];
  return (
    <>
      <PageHeading
        title="服务端插件"
        description="为 Windows ASE 地图安装插件，查看每张地图的安装和加载状态。"
        action={
          <Button
            component={Link}
            to="/instances"
            variant="outlined"
            color="inherit"
            startIcon={<ArrowLeftIcon size={18} />}
          >
            {t('返回地图管理')}
          </Button>
        }
      />
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {!data && !error && <LinearProgress />}
      {data &&
        (scope ? (
          <Stack gap={2}>
            <TextField
              select
              label={t('互通组 / 独立服')}
              value={scope.id}
              onChange={(event) => setParams({ scopeId: event.target.value })}
              sx={{ width: { xs: '100%', sm: 360 } }}
            >
              {data.scopes.map(({ id, name }) => (
                <MenuItem key={id} value={id}>
                  {name}
                </MenuItem>
              ))}
            </TextField>
            <PluginInstallation
              key={`${scope.id}:${scope.mode}`}
              data={data}
              scope={scope}
              refresh={refresh}
            />
          </Stack>
        ) : (
          <Surface>
            <Empty
              title="暂无可查看的地图"
              description="添加地图或获取地图、商店权限后可查看插件。"
            />
          </Surface>
        ))}
    </>
  );
}

export default function ServerPlugins() {
  const revision = useWorkspaceSelection((state) => state.revision);
  return <PluginWorkspace key={revision} />;
}
