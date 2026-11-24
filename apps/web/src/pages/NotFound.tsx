import { Link } from 'react-router';
import { Button } from '@mui/material';
import { Empty } from '@/components';
export default function NotFound() {
  return (
    <Empty
      title="找不到这个页面"
      description="请检查地址，或回到总览继续管理服务器。"
      action={
        <Button component={Link} to="/" variant="contained">
          返回总览
        </Button>
      }
    />
  );
}
