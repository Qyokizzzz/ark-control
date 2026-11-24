import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import {
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  Drawer,
  IconButton,
  InputBase,
  MenuItem,
  TextField,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  BellIcon,
  CalendarDotsIcon,
  CaretRightIcon,
  ChatCircleDotsIcon,
  DatabaseIcon,
  GearSixIcon,
  HardDrivesIcon,
  ListIcon,
  MagnifyingGlassIcon,
  PlanetIcon,
  PulseIcon,
  RobotIcon,
  ScrollIcon,
  SquaresFourIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { useAuthStore, usePreferences, useUiStore, useWorkspaceStore } from '@/store';
import { useWindowSize } from '@/providers';
import { PageLoading } from '@/components';
import { request } from '@/api';
import { faviconUrl, focusPageAnchor } from '@/deployment';
import { permissionsFromMask } from '@ark-control/common';
import { useWorkspaceSelection } from '@/store/workspace-selection';
import SidebarNavigation from './SidebarNavigation';

const overview = { path: '/', label: '总览', icon: SquaresFourIcon, permission: undefined };
const navigation = [
  overview,
  { path: '/hosts', label: '主机管理', icon: HardDrivesIcon, permission: /^hosts\./ },
  {
    path: '/instances',
    label: '地图管理',
    icon: PlanetIcon,
    permission: /^(maps|clusters|backups|logs|schedules|subscriptions|connections)\./,
  },
  { path: '/shop', label: '商店管理', icon: DatabaseIcon, permission: /^shop\./ },
  {
    path: '/players',
    label: '用户管理',
    icon: UsersThreeIcon,
    permission: /^(players|commerce|branches)\./,
  },
  { path: '/server-files', label: '服务端文件', icon: HardDrivesIcon, permission: /^files\./ },
  { path: '/connections', label: '好友联机', icon: UsersThreeIcon, permission: /^connections\./ },
  {
    path: '/subscriptions',
    label: '部落订阅',
    icon: ChatCircleDotsIcon,
    permission: /^subscriptions\./,
  },
  { path: '/bots', label: 'QQ 机器人', icon: RobotIcon, permission: /^bots\./ },
  { path: '/backups', label: '存档备份', icon: DatabaseIcon, permission: /^backups\./ },
  { path: '/logs', label: '运行日志', icon: ScrollIcon, permission: /^(logs|audit)\./ },
  { path: '/schedules', label: '维护计划', icon: CalendarDotsIcon, permission: /^schedules\./ },
  { path: '/workspaces', label: '我的工作空间', icon: SquaresFourIcon },
  { path: '/team', label: '成员与权限', icon: UsersThreeIcon },
  { path: '/platform', label: '平台审核', icon: GearSixIcon },
  { path: '/settings', label: '设置', icon: GearSixIcon },
];
const navigationByPath = new Map(navigation.map((item) => [item.path, item]));

export default function Shell() {
  const { t } = useTranslation();
  const { mobile } = useWindowSize();
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [drawer, setDrawer] = useState(false);
  const auth = useAuthStore();
  const selection = useWorkspaceSelection();
  const { load: loadSpaces, clear: clearSelection, active, revision } = selection;
  const accountId = auth.admin?.id;
  const savedOrder = usePreferences((state) =>
    accountId ? state.navigationOrders[accountId] : undefined,
  );
  const setNavigationOrder = usePreferences((state) => state.setNavigationOrder);
  const data = useWorkspaceStore((state) => state.data);
  const loading = useWorkspaceStore((state) => state.loading);
  const error = useWorkspaceStore((state) => state.error);
  const load = useWorkspaceStore((state) => state.load);
  const query = useWorkspaceStore((state) => state.query);
  const setQuery = useWorkspaceStore((state) => state.setQuery);
  const notice = useUiStore((state) => state.notice);
  const dismiss = useUiStore((state) => state.dismiss);
  useEffect(() => {
    if (!accountId) {
      clearSelection();
      return;
    }
    void loadSpaces(accountId);
    const timer = setInterval(() => void loadSpaces(accountId), 15000);
    return () => clearInterval(timer);
  }, [accountId, clearSelection, loadSpaces]);
  const activeId = selection.accountId === accountId ? active?.id : undefined;
  useEffect(() => {
    if (!activeId) return;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [activeId, load, revision]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
  const handleLogoutClick = useCallback(async () => {
    await request('/auth/logout', 'POST').catch(() => undefined);
    useAuthStore.getState().clear();
    clearSelection();
  }, [clearSelection]);
  const handleRefreshClick = useCallback(() => {
    if (accountId) void loadSpaces(accountId);
    if (activeId) void load();
  }, [accountId, activeId, load, loadSpaces]);
  const handleNotificationsClick = useCallback(() => {
    navigate('/logs?tab=deliveries');
  }, [navigate]);
  const handleMenuClick = useCallback(() => setDrawer((value) => !value), []);
  const orderedPaths = useMemo(
    () => [
      ...new Set([
        ...(savedOrder ?? []).filter((path) => navigationByPath.has(path)),
        ...navigationByPath.keys(),
      ]),
    ],
    [savedOrder],
  );
  const handleNavigationClick = useCallback(() => {
    setDrawer(false);
    setQuery('');
  }, [setQuery]);
  const handleNavigationMove = useCallback(
    (from: string, to: string) => {
      if (!accountId) return;
      const source = orderedPaths.indexOf(from);
      const target = orderedPaths.indexOf(to);
      if (source < 0 || target < 0 || source === target) return;
      const next = [...orderedPaths];
      next.splice(source, 1);
      next.splice(target, 0, from);
      setNavigationOrder(accountId, next);
    },
    [accountId, orderedPaths, setNavigationOrder],
  );
  if (!auth.initialized) return <PageLoading />;
  if (!auth.accessToken) return <Navigate to="/login" replace />;
  if (!selection.ready || selection.accountId !== accountId) return <PageLoading />;
  const accountPage = ['/workspaces', '/platform', '/settings'].includes(location.pathname);
  if (!activeId && !accountPage) return <Navigate to="/workspaces" replace />;
  const actions = active?.grants.flatMap((grant) => permissionsFromMask(grant.mask)) ?? [];
  const visibleNavigation = orderedPaths
    .map((path) => navigationByPath.get(path)!)
    .filter((item) => {
      if (item.path === '/platform') return auth.admin?.platformAdmin;
      if (item.path === '/team') return active?.role === 'owner';
      if (item.path === '/workspaces' || item.path === '/settings') return true;
      return (
        !!active &&
        (active.role === 'owner' ||
          !item.permission ||
          actions.some((action) => item.permission?.test(action)))
      );
    });
  const current =
    visibleNavigation.find(
      (item) => item.path !== '/' && location.pathname.startsWith(item.path),
    ) ?? overview;
  const side = (
    <Stack sx={{ height: '100%', p: 2, gap: 3 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ p: 1, pt: 2, pb: 2 }}>
        <Box component="img" src={faviconUrl} alt="" sx={{ width: 36, height: 36 }} />
        <Box>
          <Typography sx={{ fontWeight: 600, fontSize: 16, letterSpacing: '-.03em' }}>
            ARK CONTROL
          </Typography>
          <Typography color="text.secondary" variant="caption">
            {t('方舟控制台')}
          </Typography>
        </Box>
      </Stack>
      <Box>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ px: 1.5, mb: 1.5, display: 'block', letterSpacing: '.1em' }}
        >
          {t('工作空间')}
        </Typography>
        <SidebarNavigation
          items={visibleNavigation}
          currentPath={location.pathname}
          errors={data?.summary.errors ?? 0}
          onNavigate={handleNavigationClick}
          onMove={handleNavigationMove}
        />
      </Box>
      <Box sx={{ mt: 'auto' }}>
        <Box sx={{ p: 1.5, mb: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
          <Stack direction="row" alignItems="center" gap={1}>
            <PulseIcon size={16} />
            <Typography variant="caption">ASE · v1.0.0</Typography>
            <Box
              sx={{
                ml: 'auto',
                width: 6,
                height: 6,
                borderRadius: '50%',
                bgcolor: error ? 'warning.main' : 'success.main',
              }}
            />
          </Stack>
        </Box>
        <Stack direction="row" alignItems="center" gap={1.5} sx={{ px: 1 }}>
          <Box
            sx={{
              width: 32,
              height: 32,
              display: 'grid',
              placeItems: 'center',
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              fontSize: 12,
            }}
          >
            AD
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="body2" noWrap>
              {auth.admin?.name}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
              {auth.admin?.email}
            </Typography>
          </Box>
          <Tooltip title={t('退出登录')}>
            <IconButton size="small" onClick={handleLogoutClick} aria-label={t('退出登录')}>
              <ArrowSquareOutIcon size={18} />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>
    </Stack>
  );
  return (
    <Box sx={{ display: 'flex', minHeight: '100vh' }}>
      <Box component="a" href="#main-content" onClick={focusPageAnchor} className="skip-link">
        {t('跳到主要内容')}
      </Box>
      <Box
        component="nav"
        aria-label={t('工作空间')}
        sx={{ width: { md: 232 }, flexShrink: { md: 0 } }}
      >
        <Drawer
          variant={mobile ? 'temporary' : 'permanent'}
          open={!mobile || drawer}
          onClose={() => setDrawer(false)}
          sx={{
            '& .MuiDrawer-paper': {
              width: 232,
              boxSizing: 'border-box',
              bgcolor: 'background.default',
              backgroundImage: 'none',
              borderColor: 'divider',
              scrollbarWidth: 'thin',
              scrollbarColor: (theme) => `${alpha(theme.palette.text.primary, 0.28)} transparent`,
              '&::-webkit-scrollbar': { width: 6 },
              '&::-webkit-scrollbar-thumb': {
                backgroundColor: (theme) => alpha(theme.palette.text.primary, 0.28),
                borderRadius: 8,
              },
              '&::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
            },
          }}
        >
          {side}
        </Drawer>
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box
          component="header"
          sx={{
            px: { xs: 2, md: 4 },
            minHeight: 80,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'background.default',
          }}
        >
          {mobile && (
            <IconButton onClick={handleMenuClick} aria-label="打开导航" aria-expanded={drawer}>
              <ListIcon size={22} />
            </IconButton>
          )}
          <Stack
            direction="row"
            gap={1}
            alignItems="center"
            sx={{ display: { xs: 'none', lg: 'flex' }, flexShrink: 0 }}
          >
            <Typography color="text.secondary">{t('工作空间')}</Typography>
            <CaretRightIcon size={12} />
            <Typography>{t(current.label)}</Typography>
          </Stack>
          {active && (
            <TextField
              select
              size="small"
              label="当前工作空间"
              value={active.id}
              onChange={(event) => {
                selection.select(event.target.value);
                navigate('/');
              }}
              sx={{ minWidth: { xs: 130, sm: 200 }, maxWidth: { xs: 160, sm: 290 }, flexShrink: 1 }}
            >
              {selection.spaces
                .filter((item) => item.status === 'active')
                .map((item) => (
                  <MenuItem value={item.id} key={item.id}>
                    {item.name} · {item.role === 'owner' ? '服主' : '协管'}
                  </MenuItem>
                ))}
            </TextField>
          )}
          <Box
            sx={{
              ml: { lg: 'auto' },
              display: { xs: 'none', sm: 'flex' },
              alignItems: 'center',
              gap: 1,
              flex: { xs: 1, lg: 'none' },
              width: { lg: 280 },
              px: 1.5,
              py: 1,
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
            }}
          >
            <MagnifyingGlassIcon size={18} color="currentColor" />
            <InputBase
              inputRef={inputRef}
              placeholder={t('搜索地图、部落或主机')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              inputProps={{ 'aria-label': t('搜索地图、部落或主机') }}
              sx={{ fontSize: 12, width: '100%' }}
            />
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ flexShrink: 0, display: { xs: 'none', sm: 'block' } }}
            >
              Ctrl K
            </Typography>
          </Box>
          <Tooltip title={t('刷新')}>
            <IconButton onClick={handleRefreshClick} disabled={loading} aria-label={t('刷新')}>
              <ArrowClockwiseIcon size={20} />
            </IconButton>
          </Tooltip>
          {visibleNavigation.some(({ path }) => path === '/logs') && (
            <>
              <Divider orientation="vertical" flexItem sx={{ my: 3 }} />
              <Tooltip title={t('推送记录')}>
                <IconButton onClick={handleNotificationsClick} aria-label={t('推送记录')}>
                  <Badge variant="dot" color="error" invisible={!data?.summary.errors}>
                    <BellIcon size={20} />
                  </Badge>
                </IconButton>
              </Tooltip>
            </>
          )}
        </Box>
        <Box
          component="main"
          id="main-content"
          tabIndex={-1}
          sx={{ p: { xs: 2, md: 4 }, maxWidth: 1680, mx: 'auto' }}
        >
          {data?.demo && (
            <Alert severity="info" sx={{ mb: 3 }}>
              这是本地验收环境，游戏和 QQ 使用模拟服务，页面含测试数据。
            </Alert>
          )}
          {(selection.error || (activeId && error)) && (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" size="small" onClick={handleRefreshClick}>
                  {t('重试')}
                </Button>
              }
              sx={{ mb: 3 }}
            >
              {selection.error || error}
            </Alert>
          )}
          {activeId && !accountPage && !data && !error ? (
            <PageLoading />
          ) : (
            <Outlet key={revision} />
          )}
        </Box>
      </Box>
      <Snackbar
        open={!!notice}
        autoHideDuration={5000}
        onClose={dismiss}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert severity={notice?.severity ?? 'success'} onClose={dismiss} variant="filled">
          {notice?.message ? t(notice.message) : ''}
        </Alert>
      </Snackbar>
    </Box>
  );
}
