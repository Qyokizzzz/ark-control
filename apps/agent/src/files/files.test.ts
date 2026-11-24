import { describe, expect, it } from 'vitest';
import { inside } from './index';

describe('助手工作目录', () => {
  it('拒绝相对路径越界和目录本身', () => {
    expect(() => inside('/ark-root', '..', 'outside')).toThrow();
    expect(() => inside('/ark-root', '.')).toThrow();
  });
  it('允许实例内的正常文件', () => {
    expect(inside('/ark-root', 'instances', 'id', 'save.ark')).toContain('instances');
  });
});
