import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Alert,
  Button,
  Chip,
  LinearProgress,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { ArrowLeftIcon, PlusIcon } from '@phosphor-icons/react';
import {
  CLUSTER_SERVER_NAME_PREFIX_LIMIT,
  GAME_BRANCHES,
  MAPS,
  clusterSettingsSchema,
  defaultSteamServerName,
  gameAdminPasswordSchema,
  gameConfigSchema,
} from '@ark-control/common';
import type { ClusterAdminSettings, ClusterPreset, ClusterPresetGroup } from '@ark-control/common';
import { useTranslation } from 'react-i18next';
import { request } from '@/api';
import { InstanceConfigPanel, ModsDialog, PageHeading, Surface, formatDate } from '@/components';
import { PresetDialog } from '@/components/ClusterPresetActions';
import type { ClusterPresetDraft } from '@/components/ClusterPresetActions';
import { useClusterPresets } from '@/components/use-cluster-presets';
import { useUiStore } from '@/store';
import { useWorkspaceSelection } from '@/store/workspace-selection';
import { ClusterPlugins } from './ServerPlugins';

const statusLabel = {
  individual: { label: '使用地图独立密码', color: 'default' },
  restart: { label: '等待下次启动', color: 'info' },
  verifying: { label: '正在等待 RCON 确认', color: 'info' },
  failed: { label: '启动失败，请查看地图日志', color: 'error' },
  applied: { label: '已生效', color: 'success' },
  'update-agent': { label: '请更新主机助手', color: 'warning' },
} as const;

function ClusterAdminPanel({ clusterId }: { clusterId: string }) {
  const { t } = useTranslation();
  const notify = useUiStore((state) => state.notify);
  const [active, setActive] = useState<ClusterAdminSettings | null>();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const validation = password ? gameAdminPasswordSchema.safeParse(password) : null;

  const load = useCallback(
    () =>
      request<ClusterAdminSettings[]>('/clusters/admin-passwords').then(
        (results) => {
          setActive(results.find(({ id }) => id === clusterId) ?? null);
          setLoadError('');
        },
        (failure: unknown) => {
          setLoadError(failure instanceof Error ? failure.message : t('加载失败。'));
        },
      ),
    [clusterId, t],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!active || !validation?.success || saving) return;
    setSaving(true);
    setError('');
    try {
      await request(`/clusters/${encodeURIComponent(active.id)}/admin-password`, 'PATCH', {
        password: validation.data,
      });
      setPassword('');
      notify(t('游戏管理员密码已保存。'));
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('保存失败。'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack gap={2}>
      {loadError && <Alert severity="error">{loadError}</Alert>}
      {active === undefined && !loadError && <LinearProgress />}
      {active === null && !loadError && <Alert severity="info">{t('此互通组暂无地图。')}</Alert>}
      {active && (
        <>
          <Surface sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack component="form" onSubmit={save} gap={2}>
              <Stack gap={0.5}>
                <Typography variant="h4">{t('游戏管理员密码')}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {active.updatedAt
                    ? t('上次设置于 {{when}}', { when: formatDate(active.updatedAt) })
                    : t('尚未设置组内统一密码')}
                </Typography>
              </Stack>
              <Alert severity="info">
                {t(
                  '组内地图在各自下次启动时应用密码。进游戏后从控制台运行 enablecheats 并输入密码。',
                )}
              </Alert>
              <TextField
                label={t('输入新的游戏管理员密码')}
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={saving}
                onChange={(event) => setPassword(event.target.value)}
                error={validation?.success === false}
                helperText={t('游戏管理员密码需为 1–128 位字母、数字、短横线或下划线。')}
                slotProps={{ htmlInput: { maxLength: 128 } }}
                sx={{ width: { xs: '100%', sm: 420 } }}
              />
              {error && <Alert severity="error">{error}</Alert>}
              <Button
                type="submit"
                variant="contained"
                disabled={saving || !validation?.success}
                sx={{ alignSelf: 'flex-start' }}
              >
                {t('保存密码')}
              </Button>
            </Stack>
          </Surface>
          <Surface sx={{ p: { xs: 2, sm: 3 } }}>
            <Typography variant="h4" sx={{ mb: 2 }}>
              {t('组内地图')}
            </Typography>
            <Stack gap={1.25}>
              {active.maps.map((map) => (
                <Stack
                  key={map.id}
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  flexWrap="wrap"
                  gap={1}
                >
                  <Typography sx={{ overflowWrap: 'anywhere' }}>{map.name}</Typography>
                  <Chip
                    size="small"
                    color={statusLabel[map.status].color}
                    label={t(statusLabel[map.status].label)}
                  />
                </Stack>
              ))}
            </Stack>
          </Surface>
        </>
      )}
    </Stack>
  );
}

function ClusterNaming({ group, reload }: { group: ClusterPresetGroup; reload: () => void }) {
  const { t } = useTranslation();
  const notify = useUiStore((state) => state.notify);
  const [saved, setSaved] = useState(group.serverNamePrefix ?? '');
  const [prefix, setPrefix] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = clusterSettingsSchema.safeParse({ serverNamePrefix: prefix });
  const example = defaultSteamServerName(t(MAPS[0].label), prefix);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!group.canSave || !input.success || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await request<{ serverNamePrefix: string }>(
        '/clusters/' + encodeURIComponent(group.id) + '/settings',
        'PATCH',
        input.data,
      );
      setSaved(result.serverNamePrefix);
      setPrefix(result.serverNamePrefix);
      reload();
      notify(t('公共前缀已保存。'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('保存失败。'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface sx={{ p: { xs: 2, sm: 3 } }}>
      <Stack component="form" onSubmit={save} gap={2}>
        <Typography variant="h4" component="h2">
          {t('默认服名')}
        </Typography>
        <TextField
          label={t('公共前缀')}
          placeholder="爽服/50采集/10驯养/3月档/有商店/搜666"
          value={prefix}
          disabled={busy || !group.canSave}
          onChange={(event) => setPrefix(event.target.value)}
          error={!input.success}
          helperText={t('新建地图时，用公共前缀和后台地图名称生成 Steam 服名。')}
          slotProps={{ htmlInput: { maxLength: CLUSTER_SERVER_NAME_PREFIX_LIMIT } }}
          sx={{ width: { xs: '100%', sm: 580 } }}
        />
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
          {t('服名预览')} · {example}
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {group.canSave && (
          <Button
            type="submit"
            variant="contained"
            disabled={busy || !input.success || input.data.serverNamePrefix === saved}
            sx={{ alignSelf: 'flex-start' }}
          >
            {t(busy ? '正在保存…' : '保存前缀')}
          </Button>
        )}
      </Stack>
    </Surface>
  );
}

function ClusterPresetEditor({
  group,
  kind,
  reload,
}: {
  group: ClusterPresetGroup;
  kind: ClusterPreset['kind'];
  reload: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ preset?: ClusterPreset } | null>(null);
  const [draft, setDraft] = useState<ClusterPresetDraft | null>(null);
  const presets = group.presets.filter((preset) => preset.kind === kind);
  const preset = editing?.preset;
  return (
    <Stack gap={2}>
      {(!editing || kind === 'mods') && (
        <Surface sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack gap={2}>
            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              flexWrap="wrap"
              gap={1}
            >
              <Typography variant="h4" component="h2">
                {t(kind === 'game' ? '游戏配置预设' : '模组预设')}
              </Typography>
              <Button
                variant="contained"
                startIcon={<PlusIcon size={18} />}
                onClick={() => setEditing({})}
              >
                {t('新建预设')}
              </Button>
            </Stack>
            {presets.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                {t('此互通组还没有这一类配置。')}
              </Typography>
            )}
            {presets.map((item, index) => (
              <Stack
                key={item.id}
                direction="row"
                alignItems="center"
                gap={1}
                sx={{ py: 0.5, borderTop: 1, borderColor: 'divider' }}
              >
                <Typography sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {item.name}
                </Typography>
                {index === 0 && <Chip size="small" label={t('建图默认')} />}
                <Button
                  size="small"
                  onClick={() => setEditing({ preset: item })}
                  aria-label={t('编辑预设 {{name}}', { name: item.name })}
                >
                  {t('编辑')}
                </Button>
              </Stack>
            ))}
          </Stack>
        </Surface>
      )}
      {editing && kind === 'game' && (
        <>
          <Stack direction="row" alignItems="center" gap={1.5} flexWrap="wrap">
            <Button
              type="button"
              startIcon={<ArrowLeftIcon size={16} />}
              onClick={() => setEditing(null)}
            >
              {t('返回预设列表')}
            </Button>
            <Typography sx={{ overflowWrap: 'anywhere' }}>
              {preset?.name ?? t('新建预设')}
            </Typography>
          </Stack>
          <InstanceConfigPanel
            key={preset?.id ?? 'new-game'}
            presetConfig={gameConfigSchema.parse(preset?.kind === 'game' ? preset.config : {})}
            onSavePreset={(config) => setDraft({ kind: 'game', config })}
          />
        </>
      )}
      {editing && kind === 'mods' && (
        <ModsDialog
          key={preset?.id ?? 'new-mods'}
          initial={preset?.kind === 'mods' ? preset.modIds : []}
          stageOnly
          onSave={async (modIds) => setDraft({ kind: 'mods', modIds })}
          onClose={() => setEditing(null)}
        />
      )}
      {editing && draft && (
        <PresetDialog
          clusterId={group.id}
          mode="save"
          draft={draft}
          editing={{
            preset,
            onSaved: () => {
              setEditing(null);
              reload();
            },
          }}
          onClose={() => setDraft(null)}
        />
      )}
    </Stack>
  );
}

function ClusterWorkspace() {
  const { t } = useTranslation();
  const { groups, loading, error, reload } = useClusterPresets();
  const [params, setParams] = useSearchParams();
  const editable = groups.filter(
    (group) => group.canSave || group.canManagePlugins || group.canManageAdmin,
  );
  const active = editable.find((group) => group.id === params.get('group')) ?? editable[0];
  const tabs = [
    { id: 'general', label: '常规', available: true },
    { id: 'game', label: '游戏配置', available: active?.canSave },
    { id: 'mods', label: '模组', available: active?.canSave },
    { id: 'plugins', label: '服务端插件', available: active?.canManagePlugins },
    { id: 'admin', label: '游戏管理员密码', available: active?.canManageAdmin },
  ].filter(({ available }) => available);
  const tab = tabs.find(({ id }) => id === params.get('tab'))?.id ?? 'general';

  return (
    <>
      <PageHeading
        title={t('互通组设置')}
        description={t('组预设可在新建地图时选用。覆盖已有预设时，可以选择同步到组内地图。')}
        action={
          <Button
            component={Link}
            to="/instances"
            color="inherit"
            startIcon={<ArrowLeftIcon size={18} />}
          >
            {t('地图管理')}
          </Button>
        }
      />
      {loading && <LinearProgress />}
      {error && <Alert severity="error">{error}</Alert>}
      {!loading && !error && !active && (
        <Alert severity="info">{t('暂无可管理的互通组。可在新建或编辑地图时指定互通组。')}</Alert>
      )}
      {active && (
        <Stack gap={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} gap={1.5}>
            <TextField
              select
              label={t('互通组')}
              value={active.id}
              onChange={(event) => setParams({ group: event.target.value, tab })}
              sx={{ width: { xs: '100%', sm: 300 } }}
            >
              {editable.map(({ id }) => (
                <MenuItem key={id} value={id}>
                  {id}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="body2" color="text.secondary">
              {t(
                GAME_BRANCHES.find(({ value }) => value === active.branch)?.label ?? active.branch,
              )}{' '}
              · {active.mapCount} {t('张地图')}
            </Typography>
          </Stack>
          <Tabs
            value={tab}
            onChange={(_, value: string) => setParams({ group: active.id, tab: value })}
            variant="scrollable"
            scrollButtons="auto"
            aria-label={t('互通组设置')}
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            {tabs.map(({ id, label }) => (
              <Tab key={id} value={id} label={t(label)} />
            ))}
          </Tabs>
          {tab === 'general' && <ClusterNaming key={active.id} group={active} reload={reload} />}
          {(tab === 'game' || tab === 'mods') && (
            <ClusterPresetEditor
              key={active.id + ':' + tab}
              group={active}
              kind={tab}
              reload={reload}
            />
          )}
          {tab === 'plugins' && <ClusterPlugins clusterId={active.id} />}
          {tab === 'admin' && <ClusterAdminPanel key={active.id} clusterId={active.id} />}
        </Stack>
      )}
    </>
  );
}

export default function ClusterSettings() {
  const revision = useWorkspaceSelection((state) => state.revision);
  return <ClusterWorkspace key={revision} />;
}
