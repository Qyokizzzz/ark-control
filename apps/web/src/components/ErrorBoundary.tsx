import { Component } from 'react';
import type { ErrorInfo, PropsWithChildren, ReactNode } from 'react';
import { Box, Button, Typography } from '@mui/material';

class Boundary extends Component<PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, info: ErrorInfo) {
    console.error('页面渲染失败', info.componentStack);
  }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Box sx={{ p: 4, textAlign: 'center', mt: 8 }}>
        <Typography variant="h3" sx={{ mb: 2 }}>
          页面暂时无法显示
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          请重新加载页面。已提交的后台任务会继续执行。
        </Typography>
        <Button variant="contained" onClick={() => location.reload()}>
          重新加载
        </Button>
      </Box>
    );
  }
}
export default function ErrorBoundary({ children }: PropsWithChildren) {
  return <Boundary>{children}</Boundary>;
}
