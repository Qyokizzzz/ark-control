import { useCallback, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import {
  CopyIcon,
  KeyIcon,
  LinkIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  RobotIcon,
  StarIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { Bot } from '@ark-control/common';
import { useUiStore, useWorkspaceStore } from '@/store';
import { request } from '@/api';
import { apiBase } from '@/deployment';
import { useWorkspaceCan } from '@/store/workspace-selection';
import {
  ConfirmDialog,
  Empty,
  FormDialog,
  PageHeading,
  Status,
  Surface,
  formatDate,
  matches,
  useMutation,
} from '@/components';
import type { FormValues } from '@/components';

const callbackUrl = (id: string) => new URL(`${apiBase}/qq/webhook/${id}`, location.origin).href;

export default function Bots() {
  const { t } = useTranslation();
  const data = useWorkspaceStore((state) => state.data);
  const query = useWorkspaceStore((state) => state.query);
  const mutate = useMutation();
  const notify = useUiStore((state) => state.notify);
  const botWrite = useWorkspaceCan()('bots.write');
  const [edit, setEdit] = useState<Bot | 'new' | null>(null);
  const [remove, setRemove] = useState<Bot | null>(null);
  const [binding, setBinding] = useState<{
    code: string;
    instruction: string;
    expiresAt: string;
  } | null>(null);
  const [testId, setTestId] = useState<string | null>(null);
  const [groupEdit, setGroupEdit] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const handleCreateClick = useCallback(() => setEdit('new'), []);
  const handleCallbackCopyClick = useCallback(
    (id: string) => {
      void navigator.clipboard
        .writeText(callbackUrl(id))
        .then(() => notify('回调地址已复制'))
        .catch(() => notify('复制失败，请手动选择地址。', 'error'));
    },
    [notify],
  );
  const handleVerifyClick = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await mutate(() => request(`/bots/${id}/verify`, 'POST'), '凭据验证成功');
      } catch (error) {
        notify((error as Error).message, 'error');
      } finally {
        setBusyId(null);
      }
    },
    [mutate, notify],
  );
  const handleBindClick = useCallback(
    async (id: string) => {
      try {
        setBinding(await request(`/bots/${id}/binding-code`, 'POST'));
      } catch (error) {
        notify((error as Error).message, 'error');
      }
    },
    [notify],
  );
  const handleDefaultClick = useCallback(
    async (id: string) => {
      try {
        await mutate(() => request(`/bots/${id}`, 'PATCH', { isDefault: true }));
      } catch (error) {
        notify((error as Error).message, 'error');
      }
    },
    [mutate, notify],
  );
  const initial: FormValues =
    edit && edit !== 'new'
      ? {
          name: edit.name,
          appId: edit.appId,
          appSecret: '',
          owner: edit.owner,
          certified: edit.certified,
          eventMode: edit.eventMode ?? 'webhook',
          isDefault: edit.isDefault,
          enabled: edit.enabled,
        }
      : {
          name: '',
          appId: '',
          appSecret: '',
          owner: '',
          certified: false,
          eventMode: 'webhook',
          isDefault: !data?.bots.length,
          enabled: true,
        };
  const save = (values: FormValues) => {
    const payload = { ...values };
    if (!payload.appSecret) delete payload.appSecret;
    return mutate(() =>
      request(
        edit === 'new' ? '/bots' : `/bots/${(edit as Bot).id}`,
        edit === 'new' ? 'POST' : 'PATCH',
        payload,
      ),
    );
  };
  const bots = data?.bots.filter((bot) => matches(query, bot.name, bot.owner, bot.appId)) ?? [];
  const group = data?.groups.find((item) => item.id === groupEdit);
  return (
    <>
      <PageHeading
        title={t('QQ 机器人')}
        description="默认机器人与客户自带机器人分别管理，订阅选择后才会向对应群发送。"
        action={
          botWrite && (
            <Button
              variant="contained"
              startIcon={<PlusIcon size={18} />}
              onClick={handleCreateClick}
            >
              {t('添加机器人')}
            </Button>
          )
        }
      />
      <Alert severity="info" sx={{ mb: 3 }}>
        接入顺序：保存凭据 → 验证凭据 → 配置事件入口 → 生成绑定码并在群里发送 →
        测试主动推送。密钥不会在列表或日志中展示。
      </Alert>
      {bots.length ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' }, gap: 3 }}>
          {bots.map((bot) => {
            const groups = data?.groups.filter((item) => item.botId === bot.id) ?? [];
            return (
              <Surface key={bot.id} sx={{ p: 3 }}>
                <Stack
                  direction={{ xs: 'column', sm: 'row' }}
                  alignItems={{ xs: 'flex-start', sm: 'center' }}
                  justifyContent="space-between"
                  gap={2}
                  sx={{ mb: 3 }}
                >
                  <Stack direction="row" gap={2} alignItems="center" sx={{ minWidth: 0 }}>
                    <Box sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 2 }}>
                      <RobotIcon size={28} weight="duotone" />
                    </Box>
                    <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                      <Stack direction="row" alignItems="center" gap={1.5} flexWrap="wrap">
                        <Typography variant="h4">{bot.name}</Typography>
                        {bot.isDefault && (
                          <Chip label={t('默认机器人')} color="primary" variant="outlined" />
                        )}
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        AppID {bot.appId} · {bot.owner || '平台管理'}
                      </Typography>
                    </Box>
                  </Stack>
                  <Status value={bot.enabled ? bot.status : 'offline'} />
                </Stack>
                {bot.lastError && (
                  <Alert severity="warning" sx={{ mb: 3 }}>
                    {bot.lastError}
                  </Alert>
                )}
                {botWrite && (
                  <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 3 }}>
                    <Button
                      variant="outlined"
                      color="inherit"
                      onClick={() => void handleVerifyClick(bot.id)}
                      disabled={busyId === bot.id}
                      startIcon={<KeyIcon size={16} />}
                    >
                      {busyId === bot.id ? '正在验证…' : t('验证凭据')}
                    </Button>
                    <Button
                      variant="outlined"
                      color="inherit"
                      onClick={() => void handleBindClick(bot.id)}
                      startIcon={<LinkIcon size={16} />}
                    >
                      {t('绑定群')}
                    </Button>
                    {!bot.platformManaged && (
                      <Button color="inherit" onClick={() => setEdit(bot)}>
                        {t('编辑')}
                      </Button>
                    )}
                    {!bot.platformManaged && !bot.isDefault && (
                      <Button
                        color="inherit"
                        startIcon={<StarIcon size={16} />}
                        onClick={() => void handleDefaultClick(bot.id)}
                      >
                        设为默认
                      </Button>
                    )}
                    {!bot.platformManaged && (
                      <Button color="error" onClick={() => setRemove(bot)}>
                        {t('删除')}
                      </Button>
                    )}
                  </Stack>
                )}
                <Typography variant="caption" color="text.secondary">
                  凭据验证：{formatDate(bot.verifiedAt)} ·{' '}
                  {bot.certified ? '按认证机器人配额' : '按未认证机器人配额'}
                </Typography>
                {bot.eventMode === 'webhook' && (!bot.platformManaged || botWrite) && (
                  <Box sx={{ mt: 3, p: 2, bgcolor: 'action.hover', borderRadius: 2, minWidth: 0 }}>
                    <Typography sx={{ mb: 1 }}>HTTPS 事件回调</Typography>
                    <Typography
                      component="code"
                      variant="caption"
                      sx={{ display: 'block', overflowWrap: 'anywhere', mb: 1 }}
                    >
                      {callbackUrl(bot.id)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      在 QQ 开放平台填写公网 HTTPS 地址，订阅群 @机器人消息。回调经过签名校验。
                    </Typography>
                    <Button
                      size="small"
                      startIcon={<CopyIcon size={14} />}
                      onClick={() => handleCallbackCopyClick(bot.id)}
                    >
                      复制回调地址
                    </Button>
                  </Box>
                )}
                <Box sx={{ mt: 3, p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
                  <Typography sx={{ mb: 2 }}>
                    {t('已绑定的群')} · {groups.length}
                  </Typography>
                  {groups.length ? (
                    <Stack gap={2}>
                      {groups.map((item) => (
                        <Stack
                          key={item.id}
                          direction="row"
                          justifyContent="space-between"
                          alignItems="center"
                          gap={1}
                        >
                          <Box sx={{ minWidth: 0 }}>
                            <Typography noWrap>{item.name}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {item.groupNumber || `ID …${item.openId.slice(-8)}`}
                            </Typography>
                          </Box>
                          {botWrite && (
                            <Stack direction="row">
                              <Button
                                size="small"
                                color="inherit"
                                onClick={() => setGroupEdit(item.id)}
                              >
                                备注
                              </Button>
                              <Button
                                size="small"
                                startIcon={<PaperPlaneTiltIcon size={16} />}
                                onClick={() => setTestId(item.id)}
                              >
                                {t('测试发送')}
                              </Button>
                            </Stack>
                          )}
                        </Stack>
                      ))}
                    </Stack>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      生成绑定码，然后在目标群 @此机器人并发送绑定指令。
                    </Typography>
                  )}
                </Box>
              </Surface>
            );
          })}
        </Box>
      ) : (
        <Surface>
          <Empty
            title={t('尚未接入机器人')}
            description={t('接入默认或客户自带的 QQ 机器人。')}
            action={
              botWrite && (
                <Button onClick={handleCreateClick} variant="contained">
                  {t('添加机器人')}
                </Button>
              )
            }
          />
        </Surface>
      )}
      {edit && (
        <FormDialog
          title={t(edit === 'new' ? '添加机器人' : '编辑机器人')}
          fields={[
            { key: 'name', label: '机器人名称', required: true },
            { key: 'appId', label: 'AppID', required: true },
            {
              key: 'appSecret',
              label: edit === 'new' ? 'AppSecret' : '新 AppSecret（留空保留原密钥）',
              kind: 'password',
              required: edit === 'new',
            },
            { key: 'owner', label: '所属客户' },
            {
              key: 'eventMode',
              label: '事件接入方式',
              kind: 'select',
              required: true,
              options: [
                { value: 'webhook', label: 'HTTPS 回调（推荐）' },
                { value: 'websocket', label: 'WebSocket（账号支持时）' },
              ],
              helper: 'HTTPS 回调需要公网域名与证书；每台机器人分别配置自己的回调地址。',
            },
            {
              key: 'certified',
              label: '已完成主体认证',
              kind: 'switch',
              helper: '请按 QQ 平台实际认证状态设置。',
            },
            { key: 'isDefault', label: '设为默认机器人', kind: 'switch' },
            { key: 'enabled', label: '启用', kind: 'switch' },
          ]}
          initial={initial}
          onClose={() => setEdit(null)}
          onSubmit={save}
        />
      )}
      {binding && (
        <Dialog open onClose={() => setBinding(null)}>
          <DialogTitle>绑定目标QQ群</DialogTitle>
          <DialogContent>
            <Stack gap={3}>
              <Alert severity="info">
                请先将这台机器人加入目标群。在群中发送以下指令后，后台会自动识别群身份。订阅仍由你在后台手动配置。
              </Alert>
              <Typography
                component="pre"
                sx={{
                  p: 2,
                  bgcolor: 'action.hover',
                  borderRadius: 2,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  userSelect: 'all',
                }}
              >
                {binding.instruction}
              </Typography>
              <Typography color="text.secondary">
                有效期至 {formatDate(binding.expiresAt)}
                。完成后关闭窗口，在机器人卡片中查看已绑定群。
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button
              startIcon={<CopyIcon size={16} />}
              onClick={() =>
                void navigator.clipboard
                  .writeText(`绑定 ${binding.code}`)
                  .then(() => notify('复制成功'))
                  .catch(() => notify('复制失败，请手动选择指令。', 'error'))
              }
            >
              复制指令
            </Button>
            <Button onClick={() => setBinding(null)}>{t('关闭')}</Button>
          </DialogActions>
        </Dialog>
      )}
      {group && (
        <FormDialog
          title="修改群备注"
          fields={[
            { key: 'name', label: '群名称', required: true },
            { key: 'groupNumber', label: '群号（备注）' },
          ]}
          initial={{ name: group.name, groupNumber: group.groupNumber }}
          onClose={() => setGroupEdit(null)}
          onSubmit={(values) => mutate(() => request(`/groups/${group.id}`, 'PATCH', values))}
        />
      )}
      {testId && (
        <ConfirmDialog
          title="发送测试消息"
          message="将向这个已绑定QQ群发送一条连接测试消息。"
          onClose={() => setTestId(null)}
          onConfirm={() =>
            mutate(
              () => request(`/groups/${testId}/test`, 'POST'),
              'QQ 已接受测试消息，请在群内核对。',
            )
          }
        />
      )}
      {remove && (
        <ConfirmDialog
          title="删除机器人"
          message="删除此机器人的凭据和群绑定。已有订阅引用时需要先移除订阅。"
          onClose={() => setRemove(null)}
          onConfirm={() => mutate(() => request(`/bots/${remove.id}`, 'DELETE'))}
          destructive
        />
      )}
    </>
  );
}
