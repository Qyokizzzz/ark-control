import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import {
  allWorkspacePermissionsMask,
  grantAllowsArea,
  permissionMask,
  permissionsFromMask,
  workspacePermissions,
} from '@ark-control/common';
import type {
  Dashboard,
  GrantScope,
  WorkspaceGrant,
  WorkspacePermission,
  WorkspaceTeam,
} from '@ark-control/common';
import { request } from '@/api';
import { ConfirmDialog, copyText, Empty, formatDate, PageHeading, Surface } from '@/components';
import { useUiStore, useWorkspaceStore } from '@/store';
import { useWorkspaceSelection } from '@/store/workspace-selection';

interface GrantDraft {
  scope: GrantScope;
  actions: WorkspacePermission[];
}
interface Editor {
  accountId?: string;
  email: string;
  rows: GrantDraft[];
}
const fullGrant = { scope: { kind: 'workspace' as const }, mask: allWorkspacePermissionsMask };
const fromGrants = (grants: WorkspaceGrant[]): GrantDraft[] =>
  grants.map(({ scope, mask }) => ({ scope, actions: permissionsFromMask(mask) }));
const starter = fromGrants([{ scope: { kind: 'workspace' }, mask: permissionMask(['maps.read']) }]);
const areas = [
  ['workspace', '工作空间'],
  ['host', '主机与文件'],
  ['map', '地图与关联任务'],
  ['game', '玩家、商店和互通组'],
  ['cluster', '互通组设置'],
] as const;

function GrantFields({
  row,
  dashboard,
  onChange,
  onRemove,
  index,
}: {
  row: GrantDraft;
  dashboard: Dashboard | null;
  onChange: (draft: GrantDraft) => void;
  onRemove: () => void;
  index: number;
}) {
  const hosts = dashboard?.hosts ?? [];
  const maps = dashboard?.instances ?? [];
  const clusters = [...new Set(maps.map((item) => item.clusterId).filter(Boolean))];
  const scope = row.scope;
  const value = scope.kind === 'workspace' ? 'workspace' : `${scope.kind}:${scope.id}`;
  const changeScope = (next: GrantScope) =>
    onChange({
      scope: next,
      actions: row.actions.filter((action) => grantAllowsArea(next, action)),
    });
  const choose = (input: string) => {
    if (input === 'workspace') return changeScope({ kind: 'workspace' });
    const [kind, id] = input.split(':');
    if (!id) return;
    if (kind === 'host') changeScope({ kind, id, includeMaps: false });
    if (kind === 'map' || kind === 'cluster') changeScope({ kind, id });
  };
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1.5} alignItems={{ sm: 'center' }}>
        <TextField
          select
          fullWidth
          size="small"
          label={`授权范围 ${index + 1}`}
          value={value}
          onChange={(event) => choose(event.target.value)}
        >
          <MenuItem value="workspace">整个工作空间</MenuItem>
          {hosts.map((host) => (
            <MenuItem key={host.id} value={`host:${host.id}`}>
              主机 · {host.name}
            </MenuItem>
          ))}
          {clusters.map((cluster) => (
            <MenuItem key={cluster} value={`cluster:${cluster}`}>
              互通组 · {cluster}
            </MenuItem>
          ))}
          {maps.map((map) => (
            <MenuItem key={map.id} value={`map:${map.id}`}>
              地图 · {map.name}
            </MenuItem>
          ))}
          {scope.kind !== 'workspace' &&
            !(scope.kind === 'host'
              ? hosts.some(({ id }) => id === scope.id)
              : scope.kind === 'map'
                ? maps.some(({ id }) => id === scope.id)
                : clusters.includes(scope.id)) && <MenuItem value={value}>已移除的资源</MenuItem>}
        </TextField>
        <Button
          onClick={onRemove}
          color="error"
          sx={{ whiteSpace: 'nowrap', alignSelf: { xs: 'end', sm: 'center' } }}
        >
          移除此范围
        </Button>
      </Stack>
      {scope.kind === 'host' && (
        <FormControlLabel
          control={
            <Switch
              checked={scope.includeMaps}
              onChange={(_, includeMaps) => changeScope({ ...scope, includeMaps })}
            />
          }
          label="包含此主机现有和以后新增的地图"
        />
      )}
      <Divider sx={{ my: 1.5 }} />
      <Stack spacing={1.5}>
        {areas.map(([area, label]) => {
          const actions = workspacePermissions.filter(
            ([action, , itemArea]) => itemArea === area && grantAllowsArea(scope, action),
          );
          if (!actions.length) return null;
          return (
            <Box key={area}>
              <Typography variant="subtitle2">{label}</Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
                {actions.map(([action, title]) => (
                  <FormControlLabel
                    key={action}
                    label={title}
                    control={
                      <Checkbox
                        size="small"
                        checked={row.actions.includes(action)}
                        onChange={(_, checked) =>
                          onChange({
                            ...row,
                            actions: checked
                              ? [...row.actions, action]
                              : row.actions.filter((item) => item !== action),
                          })
                        }
                      />
                    }
                  />
                ))}
              </Box>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

export default function Team() {
  const workspace = useWorkspaceSelection((state) => state.active);
  const dashboard = useWorkspaceStore((state) => state.data);
  const notify = useUiStore((state) => state.notify);
  const [team, setTeam] = useState<WorkspaceTeam | null>(null);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [invite, setInvite] = useState<{ code: string; expiresAt: string } | null>(null);
  const [remove, setRemove] = useState<{ path: string; label: string; member: boolean } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const path = `/workspaces/${workspace?.id ?? ''}`;
  const owner = workspace?.role === 'owner';
  const load = useCallback(
    (current: () => boolean = () => true) =>
      request<WorkspaceTeam>(`${path}/members`).then(
        (items) => {
          if (current()) setTeam(items);
        },
        (failure: Error) => {
          if (current()) setError(failure.message);
        },
      ),
    [path],
  );
  useEffect(() => {
    if (!owner) return;
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load, owner]);

  async function save() {
    if (!editor) return;
    setSaving(true);
    setError('');
    try {
      const grants: WorkspaceGrant[] = editor.rows
        .filter(({ actions }) => actions.length)
        .map(({ scope, actions }) => ({ scope, mask: permissionMask(actions) }));
      if (editor.accountId)
        await request(`${path}/members/${editor.accountId}`, 'PATCH', { grants });
      else
        setInvite(
          await request<{ code: string; expiresAt: string }>(`${path}/invitations`, 'POST', {
            email: editor.email.trim(),
            grants,
          }),
        );
      setEditor(null);
      await load();
      notify(editor.accountId ? '权限已更新。' : '邀请代码已生成。');
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const grantLabel = ({ scope }: WorkspaceGrant) => {
    if (scope.kind === 'workspace') return '整个工作空间';
    if (scope.kind === 'cluster') return `互通组 ${scope.id}`;
    return scope.kind === 'host'
      ? `主机 ${dashboard?.hosts.find(({ id }) => id === scope.id)?.name ?? '已移除'}${scope.includeMaps ? '及其地图' : ''}`
      : `地图 ${dashboard?.instances.find(({ id }) => id === scope.id)?.name ?? '已移除'}`;
  };
  if (!owner) return <Alert severity="warning">成员与授权由这个工作空间的服主负责。</Alert>;
  return (
    <>
      <PageHeading
        title="成员与权限"
        description={`管理 ${workspace.name} 的协管成员。授权可以限定到主机、互通组或单张地图。`}
        action={
          <Button
            variant="contained"
            onClick={() => {
              setError('');
              setEditor({ email: '', rows: starter });
            }}
          >
            邀请协管
          </Button>
        }
      />
      <Stack spacing={2.5}>
        {error && !editor && <Alert severity="error">{error}</Alert>}
        {!team?.members.length && <Empty title="暂无协管成员" />}
        {team?.members.map((member) => (
          <Surface key={member.id} sx={{ p: 2.5 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5}>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="h4">{member.name}</Typography>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ overflowWrap: 'anywhere' }}
                >
                  {member.email}
                </Typography>
                <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>
                  {member.grants.map((grant, index) => (
                    <Chip
                      size="small"
                      key={index}
                      label={`${grantLabel(grant)} · ${permissionsFromMask(grant.mask).length} 项`}
                    />
                  ))}
                </Stack>
              </Box>
              <Stack direction="row" alignSelf="start" gap={0.5}>
                <Button
                  onClick={() => {
                    setError('');
                    setEditor({
                      accountId: member.accountId,
                      email: member.email,
                      rows: fromGrants(member.grants),
                    });
                  }}
                >
                  编辑权限
                </Button>
                <Button
                  color="error"
                  onClick={() =>
                    setRemove({
                      path: `${path}/members/${member.accountId}`,
                      label: member.name,
                      member: true,
                    })
                  }
                >
                  移除
                </Button>
              </Stack>
            </Stack>
          </Surface>
        ))}
        {!!team?.invitations.length && (
          <Surface sx={{ p: 2.5 }}>
            <Stack spacing={1.5} divider={<Divider />}>
              <Typography variant="h4">待接受邀请</Typography>
              {team.invitations.map((item) => (
                <Stack
                  key={item.id}
                  direction={{ xs: 'column', sm: 'row' }}
                  justifyContent="space-between"
                  gap={1}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ overflowWrap: 'anywhere' }}>{item.email}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      有效至 {formatDate(item.expiresAt)}
                    </Typography>
                  </Box>
                  <Button
                    color="error"
                    onClick={() =>
                      setRemove({
                        path: `${path}/invitations/${item.id}`,
                        label: item.email,
                        member: false,
                      })
                    }
                  >
                    撤销邀请
                  </Button>
                </Stack>
              ))}
            </Stack>
          </Surface>
        )}
      </Stack>
      <Dialog open={!!editor} fullWidth maxWidth="md" onClose={() => !saving && setEditor(null)}>
        <DialogTitle>{editor?.accountId ? '编辑协管权限' : '邀请协管'}</DialogTitle>
        {editor && (
          <DialogContent dividers>
            <Stack spacing={2}>
              {error && <Alert severity="error">{error}</Alert>}
              <TextField
                label="协管账号邮箱"
                type="email"
                value={editor.email}
                disabled={!!editor.accountId}
                onChange={(event) => setEditor({ ...editor, email: event.target.value })}
              />
              <Stack direction="row" flexWrap="wrap" gap={1}>
                <Button onClick={() => setEditor({ ...editor, rows: fromGrants([fullGrant]) })}>
                  授予全部业务权限
                </Button>
                <Button
                  onClick={() =>
                    setEditor({
                      ...editor,
                      rows: [...editor.rows, { scope: { kind: 'workspace' }, actions: [] }],
                    })
                  }
                >
                  添加授权范围
                </Button>
              </Stack>
              {editor.rows.map((row, index) => (
                <GrantFields
                  key={index}
                  row={row}
                  index={index}
                  dashboard={dashboard}
                  onChange={(draft) =>
                    setEditor({
                      ...editor,
                      rows: editor.rows.map((item, i) => (i === index ? draft : item)),
                    })
                  }
                  onRemove={() =>
                    setEditor({ ...editor, rows: editor.rows.filter((_, i) => i !== index) })
                  }
                />
              ))}
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setEditor(null)} disabled={saving}>
            取消
          </Button>
          <Button
            variant="contained"
            onClick={() => void save()}
            disabled={
              saving || !editor?.email.trim() || !editor.rows.some(({ actions }) => actions.length)
            }
          >
            {editor?.accountId ? '保存权限' : '生成邀请'}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!invite} onClose={() => setInvite(null)} fullWidth maxWidth="sm">
        <DialogTitle>分享邀请代码</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography color="text.secondary">
              把代码发给受邀账号。邀请为一次性使用，有效至 {formatDate(invite?.expiresAt ?? null)}。
            </Typography>
            <TextField
              fullWidth
              label="邀请代码"
              value={invite?.code ?? ''}
              slotProps={{ input: { readOnly: true } }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInvite(null)}>关闭</Button>
          <Button
            variant="contained"
            onClick={() =>
              void copyText(invite?.code ?? '').then(
                () => notify('已复制邀请代码。'),
                () => notify('请选中代码后手动复制。', 'info'),
              )
            }
          >
            复制代码
          </Button>
        </DialogActions>
      </Dialog>
      {remove && (
        <ConfirmDialog
          title={remove.member ? '移除协管成员' : '撤销邀请'}
          destructive
          message={
            remove.member
              ? `确认移除 ${remove.label} 的访问资格？`
              : `确认撤销发给 ${remove.label} 的邀请？`
          }
          onClose={() => setRemove(null)}
          onConfirm={async () => {
            await request(remove.path, 'DELETE');
            await load();
          }}
        />
      )}
    </>
  );
}
