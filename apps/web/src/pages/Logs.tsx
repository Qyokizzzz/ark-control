import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Box,
  Button,
  MenuItem,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import type { Delivery } from '@ark-control/common';
import { formatTribeMessage } from '@ark-control/common';
import { useWorkspaceStore } from '@/store';
import { request } from '@/api';
import {
  ConfigAuditDialog,
  ConfirmDialog,
  Empty,
  PageHeading,
  Status,
  Surface,
  formatDate,
  matches,
  useMutation,
} from '@/components';

export default function Logs() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') ?? 'events';
  const auditId = tab === 'audit' ? searchParams.get('entry') : null;
  const [instanceId, setInstanceId] = useState('');
  const [retry, setRetry] = useState<Delivery | null>(null);
  const data = useWorkspaceStore((state) => state.data);
  const query = useWorkspaceStore((state) => state.query);
  const mutate = useMutation();
  const handleTabChange = useCallback(
    (_event: React.SyntheticEvent, value: string) => setSearchParams({ tab: value }),
    [setSearchParams],
  );
  const handleCloseAudit = useCallback(() => {
    setSearchParams({ tab: 'audit' }, { replace: true });
  }, [setSearchParams]);
  const events =
    data?.events.filter(
      (event) =>
        (!instanceId || event.instanceId === instanceId) &&
        matches(query, event.text, event.tribeName, event.tribeId),
    ) ?? [];
  const deliveries =
    data?.deliveries.filter(
      (delivery) =>
        (!instanceId || delivery.instanceId === instanceId) &&
        matches(
          query,
          delivery.body,
          delivery.tribeName,
          delivery.lastError,
          data.groups.find((group) => group.id === delivery.groupId)?.name,
        ),
    ) ?? [];
  const consoleEntries =
    data?.console.filter(
      (entry) => (!instanceId || entry.instanceId === instanceId) && matches(query, entry.text),
    ) ?? [];
  const audit =
    data?.audit.filter(
      (entry) =>
        (!instanceId || instanceId === entry.instanceId) &&
        matches(query, entry.action, entry.target, entry.actor, entry.detail),
    ) ?? [];
  return (
    <>
      <PageHeading
        title={t('运行日志')}
        description="查看原始部落事件、推送结果和维护操作。QQ 已接受消息不等于所有群成员已阅读。"
      />
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        gap={2}
        sx={{ mb: 3 }}
      >
        <Tabs value={tab} onChange={handleTabChange} variant="scrollable" scrollButtons="auto">
          <Tab value="events" label={t('部落日志')} />
          <Tab value="deliveries" label={t('推送记录')} />
          <Tab value="console" label={t('运行日志')} />
          <Tab value="audit" label={t('操作记录')} />
        </Tabs>
        <TextField
          select
          label="筛选地图"
          value={instanceId}
          onChange={(event) => setInstanceId(event.target.value)}
          sx={{ width: { xs: '100%', sm: 200 } }}
        >
          <MenuItem value="">{t('全部地图')}</MenuItem>
          {data?.instances.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {item.name}
            </MenuItem>
          ))}
        </TextField>
      </Stack>
      <Surface>
        {tab === 'events' &&
          (events.length ? (
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>时间</TableCell>
                    <TableCell>地图与部落</TableCell>
                    <TableCell>原始日志</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {events.slice(0, 300).map((event) => (
                    <TableRow key={event.id}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {formatDate(event.receivedAt)}
                      </TableCell>
                      <TableCell>
                        <Typography>
                          {data?.instances.find((item) => item.id === event.instanceId)?.mapLabel} ·{' '}
                          {event.tribeName}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          部落 ID {event.tribeId}
                        </Typography>
                      </TableCell>
                      <TableCell
                        sx={{ whiteSpace: 'pre-wrap', minWidth: 220, overflowWrap: 'anywhere' }}
                      >
                        {event.text}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Empty
              title="暂无部落日志"
              description="主机接入并采集游戏事件后，原始日志会保存在这里。"
            />
          ))}
        {tab === 'deliveries' &&
          (deliveries.length ? (
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>消息</TableCell>
                    <TableCell>目标群</TableCell>
                    <TableCell>状态</TableCell>
                    <TableCell>时间</TableCell>
                    <TableCell>操作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {deliveries.slice(0, 300).map((delivery) => (
                    <TableRow key={delivery.id}>
                      <TableCell sx={{ minWidth: 260, maxWidth: 600, overflowWrap: 'anywhere' }}>
                        <Typography>
                          {formatTribeMessage(
                            delivery.mapLabel,
                            delivery.tribeName,
                            delivery.body,
                            delivery.count,
                          )}
                        </Typography>
                        {delivery.lastError && (
                          <Typography
                            variant="caption"
                            color="warning.main"
                            sx={{ display: 'block', mt: 1 }}
                          >
                            {delivery.lastError}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell sx={{ minWidth: 140 }}>
                        <Typography>
                          {data?.groups.find((item) => item.id === delivery.groupId)?.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {data?.bots.find((item) => item.id === delivery.botId)?.name}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Status value={delivery.status} />
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {formatDate(delivery.sentAt ?? delivery.firstAt)}
                      </TableCell>
                      <TableCell>
                        {['blocked', 'retry', 'uncertain'].includes(delivery.status) && (
                          <Button onClick={() => setRetry(delivery)}>{t('重试')}</Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Empty title="暂无推送记录" description="设置部落订阅后，日志将进入 30 秒合并窗口。" />
          ))}
        {tab === 'console' &&
          (consoleEntries.length ? (
            <Box sx={{ p: 3, maxHeight: 680, overflow: 'auto', fontFamily: 'monospace' }}>
              {consoleEntries.map((entry) => (
                <Stack key={entry.id} direction="row" gap={2} sx={{ py: 1 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {formatDate(entry.createdAt)}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      fontFamily: 'inherit',
                      whiteSpace: 'pre-wrap',
                      overflowWrap: 'anywhere',
                      color: entry.level === 'error' ? 'error.main' : 'text.primary',
                    }}
                  >
                    [{data?.instances.find((item) => item.id === entry.instanceId)?.name}]{' '}
                    {entry.text}
                  </Typography>
                </Stack>
              ))}
            </Box>
          ) : (
            <Empty title="暂无运行日志" />
          ))}
        {tab === 'audit' &&
          (audit.length ? (
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('操作')}</TableCell>
                    <TableCell>{t('对象')}</TableCell>
                    <TableCell>{t('操作用户')}</TableCell>
                    <TableCell>{t('详情')}</TableCell>
                    <TableCell>{t('时间')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {audit.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>{entry.action}</TableCell>
                      <TableCell>{entry.target}</TableCell>
                      <TableCell sx={{ minWidth: 140, overflowWrap: 'anywhere' }}>
                        {entry.actor}
                      </TableCell>
                      <TableCell sx={{ minWidth: 200, overflowWrap: 'anywhere' }}>
                        {entry.detail}
                        {!!entry.changeCount && (
                          <Box>
                            <Button
                              component={Link}
                              to={`/logs?tab=audit&entry=${entry.id}`}
                              size="small"
                              sx={{ px: 0 }}
                            >
                              {t('查看完整记录')}
                            </Button>
                          </Box>
                        )}
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {formatDate(entry.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : (
            <Empty title="暂无操作记录" />
          ))}
      </Surface>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        页面展示最近记录：部落和推送各最多 300 条，运行日志最多 400 条，操作记录最多 100 条。
      </Typography>
      {auditId && <ConfigAuditDialog key={auditId} id={auditId} onClose={handleCloseAudit} />}
      {retry && (
        <ConfirmDialog
          title="重新推送"
          message={
            retry.status === 'uncertain'
              ? '上次请求可能已被 QQ 接受。请先检查群内没有此消息，再确认重试，避免重复。'
              : '将使用这条记录原来绑定的机器人和群重试。请先处理权限或连接问题。'
          }
          onClose={() => setRetry(null)}
          onConfirm={() =>
            mutate(
              () =>
                request(`/deliveries/${retry.id}/retry`, 'POST', {
                  acknowledgeUncertain: retry.status === 'uncertain',
                }),
              '重试已加入队列',
            )
          }
        />
      )}
    </>
  );
}
