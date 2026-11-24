import { describe, expect, it } from 'vitest';
import { signQqChallenge, verifyQqRequest } from './signatures';

describe('QQ 官方 Ed25519 测试向量', () => {
  it('回调验证结果与官方已知向量一致', () => {
    expect(signQqChallenge('DG5g3B4j9X2KOErG', '1725442341', 'Arq0D5A61EgUu4OxUvOp')).toBe(
      '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706',
    );
  });
  const raw = Buffer.from('Arq0D5A61EgUu4OxUvOp');
  const signature =
    '87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706';
  it('接受正确的原始请求字节与官方签名', () => {
    expect(verifyQqRequest('DG5g3B4j9X2KOErG', '1725442341', raw, signature)).toBe(true);
  });
  it('拒绝正文篡改、错误机器人密钥及畸形签名', () => {
    expect(verifyQqRequest('DG5g3B4j9X2KOErG', '1725442341', Buffer.from('{}'), signature)).toBe(
      false,
    );
    expect(verifyQqRequest('another-bot-secret', '1725442341', raw, signature)).toBe(false);
    expect(verifyQqRequest('another-bot-secret', '1725442341', raw, 'not-hex')).toBe(false);
  });
});
