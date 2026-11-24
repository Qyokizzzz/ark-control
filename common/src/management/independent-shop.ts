import { z } from 'zod';
import type { ManagedPlayer } from '@common/types';

export const shopModeSchema = z.enum(['arkshop', 'independent']);
export type ShopMode = z.infer<typeof shopModeSchema>;
export const defaultShopMode: ShopMode = 'arkshop';
export const independentShopFeature = 'independent-shop-v1';
export const shopRequestLifetimeMs = 60_000;
export const shopReceiptGraceMs = 60_000;
export const shopMaxPurchaseQuantity = 100;

const productId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,80}$/, '商品编号须为字母、数字、下划线或短横线。');
const blueprint = z
  .string()
  .max(400)
  .regex(
    /^Blueprint'\/Game\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'$/,
    "蓝图须使用 Blueprint'/Game/…/对象.对象' 格式。",
  );
const points = z.number().int().min(0).max(100_000_000);

export const shopDeliverySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('item'),
      blueprint,
      amount: z.number().int().min(1).max(10_000).default(1),
      quality: z.number().min(0).max(1000).default(0),
      blueprintOnly: z.boolean().default(false),
      armor: z.number().min(0).max(100_000).optional(),
      durability: z.number().min(0).max(100_000).optional(),
      damage: z.number().min(0).max(100_000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dino'),
      blueprint,
      level: z.number().int().min(1).max(1000),
    })
    .strict(),
]);

export const independentProductSchema = z
  .object({
    id: productId,
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\p{Cc}]+$/u, '商品名称不能包含换行等控制字符。'),
    price: points.min(1),
    vipPrice: points.nullable().default(null),
    limitPerPlayer: z.number().int().min(1).max(1_000_000).nullable().default(null),
    enabled: z.boolean().default(true),
    delivery: z.array(shopDeliverySchema).min(1).max(10),
  })
  .superRefine((product, context) => {
    if (product.vipPrice !== null && product.vipPrice > product.price)
      context.addIssue({ code: 'custom', path: ['vipPrice'], message: 'VIP 价不能高于普通售价。' });
    if (product.delivery.some(({ kind }) => kind === 'dino') && product.delivery.length !== 1)
      context.addIssue({
        code: 'custom',
        path: ['delivery'],
        message: '恐龙商品一次发放一只，请使用单条发货定义。',
      });
  });

export const independentCatalogSchema = z
  .array(independentProductSchema)
  .max(300)
  .superRefine((products, context) => {
    if (new Set(products.map(({ id }) => id)).size !== products.length)
      context.addIssue({ code: 'custom', message: '商品编号不能重复。' });
  });

const requestFields = {
  id: z.string().uuid(),
  steamId: z.string().regex(/^765\d{14}$/),
  createdAt: z.number().int().positive(),
};
export const chatShopRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...requestFields, kind: z.literal('shop'), page: z.number().int().min(1).max(100) }),
  z.object({ ...requestFields, kind: z.literal('points') }),
  z.object({
    ...requestFields,
    kind: z.literal('buy'),
    productId,
    quantity: z.number().int().min(1).max(shopMaxPurchaseQuantity),
  }),
]);

export const chatShopReceiptSchema = z.object({
  id: requestFields.id,
  steamId: requestFields.steamId,
  outcome: z.enum(['delivered', 'failed', 'uncertain']),
  reason: z.string().max(500).default(''),
});

export type ShopDelivery = z.infer<typeof shopDeliverySchema>;
export type IndependentProduct = z.infer<typeof independentProductSchema>;
export type ChatShopRequest = z.infer<typeof chatShopRequestSchema>;
export type ChatShopReceipt = z.infer<typeof chatShopReceiptSchema>;

export interface IndependentCatalog {
  id: string;
  revision: number;
  products: IndependentProduct[];
}

export interface IndependentWallet {
  id: string;
  scopeId: string;
  steamId: string;
  balance: number;
  reserved: number;
  vip: ManagedPlayer['vip'];
  updatedAt: string | null;
}

export interface ShopOrder {
  id: string;
  scopeId: string;
  instanceId: string;
  hostId: string;
  steamId: string;
  productId: string;
  name: string;
  quantity: number;
  total: number;
  delivery: ShopDelivery[];
  status: 'pending' | 'delivered' | 'refunded' | 'uncertain';
  reason: string;
  createdAt: string;
  expiresAt: number;
  completedAt: string | null;
}

export type ChatShopReply =
  { lines: string[] } | { delivery: ShopDelivery[]; quantity: number; expiresAt: number };

export interface ShopOrderPage {
  entries: ShopOrder[];
  page: number;
  hasMore: boolean;
}
