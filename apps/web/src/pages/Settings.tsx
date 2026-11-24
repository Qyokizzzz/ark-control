import { Alert, Box, Button, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { CheckIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { usePreferences } from '@/store';
import { PageHeading, Surface } from '@/components';

export default function Settings() {
  const { t } = useTranslation();
  const theme = usePreferences((state) => state.theme);
  const setTheme = usePreferences((state) => state.setTheme);
  const language = usePreferences((state) => state.language);
  const setLanguage = usePreferences((state) => state.setLanguage);
  return (
    <>
      <PageHeading title={t('设置')} description="管理你的控制台外观和界面偏好。" />
      <Stack gap={3}>
        <Surface sx={{ p: 3 }}>
          <Typography variant="h4" sx={{ mb: 1 }}>
            {t('外观主题')}
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            外观选择保存在当前浏览器。
          </Typography>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(5, 1fr)' },
              gap: 2,
            }}
          >
            {[
              { id: 'light', label: '明亮', background: '#f5f6f3', accent: '#40713d' },
              { id: 'dark', label: '深色', background: '#181818', accent: '#b9ed80' },
              { id: 'blue', label: '蓝色', background: '#f3f6fc', accent: '#345fce' },
              { id: 'pink', label: '粉色', background: '#fcf5f8', accent: '#ad4277' },
              { id: 'yellow', label: '黄色', background: '#fbf8ed', accent: '#8b6611' },
            ].map((item) => (
              <Button
                key={item.id}
                variant="outlined"
                aria-pressed={theme === item.id}
                onClick={() => setTheme(item.id as typeof theme)}
                sx={{
                  p: 2,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  borderColor: theme === item.id ? 'primary.main' : 'divider',
                  color: 'text.primary',
                }}
              >
                <Box
                  sx={{
                    bgcolor: item.background,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 2,
                    width: '100%',
                    height: 80,
                    p: 2,
                  }}
                >
                  <Box
                    sx={{
                      bgcolor: item.accent,
                      opacity: 0.6,
                      height: 8,
                      width: '50%',
                      borderRadius: 1,
                      mb: 1,
                    }}
                  />
                  <Box
                    sx={{
                      bgcolor: item.accent,
                      opacity: 0.15,
                      height: 24,
                      width: '100%',
                      borderRadius: 1,
                    }}
                  />
                </Box>
                <Stack direction="row" gap={1} alignItems="center">
                  {t(item.label)}
                  {theme === item.id && <CheckIcon size={16} />}
                </Stack>
              </Button>
            ))}
          </Box>
        </Surface>
        <Surface sx={{ p: 3 }}>
          <Typography variant="h4" sx={{ mb: 3 }}>
            {t('界面语言')}
          </Typography>
          <TextField
            select
            value={language}
            label={t('界面语言')}
            onChange={(event) => setLanguage(event.target.value as typeof language)}
            sx={{ maxWidth: 320 }}
          >
            <MenuItem value="zh-CN">简体中文</MenuItem>
            <MenuItem value="en">English</MenuItem>
          </TextField>
        </Surface>
        <Surface sx={{ p: 3 }}>
          <Typography variant="h4" sx={{ mb: 3 }}>
            推送规则
          </Typography>
          <Alert severity="info">
            部落日志按同名内容固定合并 30 秒，到期提交
            QQ。原始日志独立保留；重复上报不会累计两次。目标机器人和群由每条订阅明确指定。
          </Alert>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 3, display: 'block' }}>
            QQ
            接口认证、主动消息权限和平台配额，以实际接入账号为准。加密密钥和数据库连接在服务器环境配置中维护。
          </Typography>
        </Surface>
      </Stack>
    </>
  );
}
