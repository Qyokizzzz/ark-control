import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Chip, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { ArrowLeftIcon } from '@phosphor-icons/react';
import { gameAdminPasswordSchema } from '@ark-control/common';
import type { ClusterAdminSettings } from '@ark-control/common';
import { useTranslation } from 'react-i18next';
import { request } from '@/api';
import { PageHeading, Surface, formatDate } from '@/components';
import { useUiStore } from '@/store';

const statusLabel = {
  individual: { label: '使用地图独立密码', color: 'default' },
  restart: { label: '等待下次启动', color: 'info' },
  verifying: { label: '正在等待 RCON 确认', color: 'info' },
  failed: { label: '启动失败，请查看地图日志', color: 'error' },
  applied: { label: '已生效', color: 'success' },
  'update-agent': { label: '请更新主机助手', color: 'warning' },
} as const;

export default function ClusterSettings() {
  const { t } = useTranslation();
  const notify = useUiStore((state) => state.notify);
  const [groups, setGroups] = useState<ClusterAdminSettings[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [input, setInput] = useState({ clusterId: '', password: '' });
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const active = groups?.find(({ id }) => id === selectedId) ?? groups?.[0];
  const password = input.clusterId === active?.id ? input.password : '';
  const validation = password ? gameAdminPasswordSchema.safeParse(password) : null;

  const load = useCallback(
    () =>
      request<ClusterAdminSettings[]>('/clusters/admin-passwords').then(
        (results) => {
          setGroups(results);
          setLoadError('');
        },
        (failure: unknown) => {
          setLoadError(failure instanceof Error ? failure.message : t('加载失败。'));
        },
      ),
    [t],
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
      setInput({ clusterId: '', password: '' });
      notify(t('游戏管理员密码已保存。'));
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('保存失败。'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeading
        title={t('互通组设置')}
        description={t('选择互通组，查看各张地图的密码生效状态。')}
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
      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}
      {groups?.length === 0 && (
        <Alert severity="info">{t('暂无可管理的互通组。可在新建或编辑地图时指定互通组。')}</Alert>
      )}
      {active && (
        <Stack gap={2}>
          <TextField
            select
            id="cluster-admin-group"
            label={t('互通组')}
            value={active.id}
            disabled={saving}
            onChange={(event) => {
              setSelectedId(event.target.value);
              setInput({ clusterId: '', password: '' });
              setError('');
            }}
            sx={{ width: { xs: '100%', sm: 300 } }}
          >
            {groups?.map(({ id }) => (
              <MenuItem key={id} value={id}>
                {id}
              </MenuItem>
            ))}
          </TextField>
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
                onChange={(event) =>
                  setInput({ clusterId: active.id, password: event.target.value })
                }
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
        </Stack>
      )}
    </>
  );
}
