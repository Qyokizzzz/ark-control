import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import type { PlatformWorkspace, Workspace, WorkspaceStatus } from '@ark-control/common';
import { workspaceStatuses } from '@ark-control/common';
import { request } from '@/api';
import { ConfirmDialog, Empty, FormDialog, PageHeading, Surface, formatDate } from '@/components';
import { useAuthStore, useUiStore } from '@/store';
import { useWorkspaceSelection } from '@/store/workspace-selection';

const fields = [
  {
    key: 'hosts',
    label: '主机数上限',
    kind: 'number',
    min: 0,
    max: 100000,
    helper: '留空表示不限',
  },
  { key: 'maps', label: '地图数上限', kind: 'number', min: 0, max: 100000, helper: '留空表示不限' },
  {
    key: 'members',
    label: '协管成员数上限',
    kind: 'number',
    min: 0,
    max: 100000,
    helper: '留空表示不限',
  },
] as const;
const reviewLabels = { active: '开通工作空间', rejected: '拒绝申请', suspended: '暂停工作空间' };

export default function Platform() {
  const account = useAuthStore((state) => state.admin);
  const notify = useUiStore((state) => state.notify);
  const refreshSpaces = useWorkspaceSelection((state) => state.load);
  const [spaces, setSpaces] = useState<PlatformWorkspace[] | null>(null);
  const [error, setError] = useState('');
  const [limits, setLimits] = useState<PlatformWorkspace | null>(null);
  const [review, setReview] = useState<{
    space: PlatformWorkspace;
    status: Exclude<WorkspaceStatus, 'pending'>;
  } | null>(null);
  const load = useCallback(
    (current: () => boolean = () => true) =>
      request<PlatformWorkspace[]>('/platform/workspaces').then(
        (items) => {
          if (!current()) return;
          setSpaces(items);
          setError('');
        },
        (failure: Error) => {
          if (current()) setError(failure.message);
        },
      ),
    [],
  );
  useEffect(() => {
    if (!account?.platformAdmin) return;
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [account?.platformAdmin, load]);
  async function save(id: string, patch: Partial<Pick<Workspace, 'status' | 'limits'>>) {
    await request(`/platform/workspaces/${id}`, 'PATCH', patch);
    await Promise.all([load(), refreshSpaces(account!.id)]);
    notify('工作空间已更新。');
  }
  if (!account?.platformAdmin) return <Alert severity="warning">此页面需要平台管理员权限。</Alert>;
  return (
    <>
      <PageHeading
        title="平台审核"
        description="审核服主开通申请，调整各空间的主机、地图和协管人数上限。"
        action={<Button onClick={() => void load()}>刷新列表</Button>}
      />
      <Stack spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}
        {spaces?.length === 0 && <Empty title="没有工作空间" />}
        {spaces
          ?.slice()
          .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'))
          .map((space) => (
            <Surface key={space.id} sx={{ p: 2.5 }}>
              <Stack direction={{ xs: 'column', md: 'row' }} gap={2} justifyContent="space-between">
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
                    <Typography variant="h4" sx={{ overflowWrap: 'anywhere' }}>
                      {space.name}
                    </Typography>
                    <Chip
                      size="small"
                      color={space.status === 'pending' ? 'warning' : 'default'}
                      label={workspaceStatuses[space.status]}
                    />
                  </Stack>
                  <Typography
                    color="text.secondary"
                    variant="body2"
                    sx={{ overflowWrap: 'anywhere', mt: 1 }}
                  >
                    {space.owner?.name} · {space.owner?.email} · 申请于{' '}
                    {formatDate(space.createdAt)}
                  </Typography>
                  <Typography color="text.secondary" variant="body2">
                    主机 {space.limits.hosts ?? '不限'} · 地图 {space.limits.maps ?? '不限'} · 协管{' '}
                    {space.limits.members ?? '不限'}
                  </Typography>
                </Box>
                <Stack direction="row" flexWrap="wrap" alignItems="start" gap={0.5}>
                  <Button onClick={() => setLimits(space)}>额度</Button>
                  {space.status === 'pending' && (
                    <Button color="error" onClick={() => setReview({ space, status: 'rejected' })}>
                      拒绝
                    </Button>
                  )}
                  {space.status !== 'active' ? (
                    <Button
                      variant="contained"
                      onClick={() => setReview({ space, status: 'active' })}
                    >
                      {space.status === 'suspended' ? '恢复' : '开通'}
                    </Button>
                  ) : (
                    <Button color="error" onClick={() => setReview({ space, status: 'suspended' })}>
                      暂停
                    </Button>
                  )}
                </Stack>
              </Stack>
            </Surface>
          ))}
      </Stack>
      {limits && (
        <FormDialog
          title={`设置额度 · ${limits.name}`}
          fields={[...fields]}
          initial={Object.fromEntries(
            Object.entries(limits.limits).map(([key, value]) => [
              key,
              value === null ? '' : String(value),
            ]),
          )}
          onClose={() => setLimits(null)}
          onSubmit={async (values) => {
            const value = (key: string) =>
              String(values[key] ?? '').trim() ? Number(values[key]) : null;
            await save(limits.id, {
              limits: { hosts: value('hosts'), maps: value('maps'), members: value('members') },
            });
          }}
        />
      )}
      {review && (
        <ConfirmDialog
          title={reviewLabels[review.status]}
          destructive={review.status !== 'active'}
          message={`确认${reviewLabels[review.status]}「${review.space.name}」？`}
          onClose={() => setReview(null)}
          onConfirm={() => save(review.space.id, { status: review.status })}
        />
      )}
    </>
  );
}
