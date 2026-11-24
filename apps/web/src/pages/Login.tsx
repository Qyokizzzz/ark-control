import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router';
import { Alert, Box, Button, Stack, TextField, Typography } from '@mui/material';
import {
  ArrowRightIcon,
  ChatCircleDotsIcon,
  HardDrivesIcon,
  PlanetIcon,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { registerSchema } from '@ark-control/common';
import type { Admin } from '@ark-control/common';
import { useAuthStore } from '@/store';
import { request } from '@/api';
import { faviconUrl } from '@/deployment';

export default function Login() {
  const { t } = useTranslation();
  const token = useAuthStore((state) => state.accessToken);
  const initialized = useAuthStore((state) => state.initialized);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [register, setRegister] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [rejectedEmail, setRejectedEmail] = useState<{ email: string; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const registration = register ? registerSchema.safeParse({ name, email, password }) : null;
  const fieldError = (key: 'name' | 'email' | 'password') =>
    submitted && registration && !registration.success
      ? registration.error.issues.find((issue) => issue.path[0] === key)?.message
      : undefined;
  const emailError =
    fieldError('email') ??
    (register && rejectedEmail?.email === email ? rejectedEmail.message : undefined);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setRejectedEmail(null);
    if (registration) {
      setSubmitted(true);
      if (!registration.success) return;
    }
    setBusy(true);
    try {
      const data = await request<{ accessToken: string; admin: Admin }>(
        register ? '/auth/register' : '/auth/login',
        'POST',
        registration?.data ?? { email, password },
      );
      useAuthStore.getState().setSession(data.accessToken, data.admin);
    } catch (failure) {
      if (register && failure instanceof Error && failure.cause === 'EMAIL_IN_USE') {
        setRejectedEmail({ email, message: failure.message });
      } else {
        setError(failure instanceof Error ? failure.message : '提交失败。');
      }
    } finally {
      setBusy(false);
    }
  }
  if (initialized && token) return <Navigate to="/" replace />;
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
      }}
    >
      <Stack
        sx={{
          p: { xs: 3, md: 8 },
          borderRightWidth: { md: 1 },
          borderRightStyle: { md: 'solid' },
          borderColor: 'divider',
          justifyContent: 'space-between',
          gap: 8,
          bgcolor: 'background.paper',
          display: { xs: 'none', md: 'flex' },
        }}
      >
        <Stack direction="row" alignItems="center" gap={1.5}>
          <Box component="img" src={faviconUrl} alt="" sx={{ width: 40, height: 40 }} />
          <Typography sx={{ fontWeight: 600, letterSpacing: '.1em' }}>ARK CONTROL</Typography>
        </Stack>
        <Box>
          <Typography variant="overline" color="primary.main">
            YOUR WORLDS, CONNECTED
          </Typography>
          <Typography
            variant="h1"
            sx={{ mt: 3, mb: 3, fontSize: { md: 48, lg: 60 }, lineHeight: 1.1 }}
          >
            让每一张地图
            <br />
            有序运行。
          </Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 400, lineHeight: 1.8 }}>
            从主机资源到部落日志，在一个控制台里管理你的方舟服务器。
          </Typography>
          <Stack direction="row" alignItems="center" gap={2} sx={{ mt: 6 }}>
            {[
              { icon: HardDrivesIcon, text: '主机' },
              { icon: PlanetIcon, text: '地图' },
              { icon: ChatCircleDotsIcon, text: '部落' },
            ].map(({ icon: Icon, text }) => (
              <Box
                key={text}
                sx={{ p: 3, border: 1, borderColor: 'divider', borderRadius: 3, flex: 1 }}
              >
                <Icon size={24} weight="duotone" />
                <Typography sx={{ mt: 2 }}>{t(text)}</Typography>
              </Box>
            ))}
          </Stack>
        </Box>
        <Typography variant="caption" color="text.secondary">
          ARK: Survival Evolved · 管理工作空间
        </Typography>
      </Stack>
      <Stack alignItems="center" justifyContent="center" sx={{ p: { xs: 3, md: 6 } }}>
        <Box sx={{ width: '100%', maxWidth: 400 }}>
          <Box
            component="img"
            src={faviconUrl}
            alt=""
            sx={{ width: 48, mb: 4, display: { md: 'none' } }}
          />
          <Typography variant="h2" sx={{ mb: 1.5 }}>
            {register ? '注册账号' : t('登录管理后台')}
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 4 }}>
            {register
              ? '注册后可以申请服主工作空间，或接受已有空间的邀请。'
              : '登录后进入你的方舟工作空间。'}
          </Typography>
          <Stack component="form" noValidate={register} onSubmit={handleSubmit} spacing={3}>
            {error && <Alert severity="error">{error}</Alert>}
            {register && (
              <TextField
                label="显示名称"
                required
                autoComplete="nickname"
                error={!!fieldError('name')}
                helperText={fieldError('name')}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
            <TextField
              label={t('邮箱')}
              type="email"
              required
              autoComplete="username"
              error={!!emailError}
              helperText={emailError}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <TextField
              label={t('密码')}
              type="password"
              required
              autoComplete={register ? 'new-password' : 'current-password'}
              error={!!fieldError('password')}
              helperText={register ? (fieldError('password') ?? '至少 12 个字符') : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button
              type="submit"
              variant="contained"
              disabled={busy || !initialized}
              endIcon={<ArrowRightIcon size={18} />}
            >
              {busy ? '正在提交…' : register ? '注册' : t('登录')}
            </Button>
          </Stack>
          <Button
            sx={{ mt: 2 }}
            disabled={busy}
            onClick={() => {
              setRegister(!register);
              setSubmitted(false);
              setRejectedEmail(null);
              setError(null);
              setPassword('');
            }}
          >
            {register ? '已有账号，返回登录' : '创建账号'}
          </Button>
        </Box>
      </Stack>
    </Box>
  );
}
