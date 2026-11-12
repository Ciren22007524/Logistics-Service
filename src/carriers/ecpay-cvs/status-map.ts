import type { ShipmentStatus } from '../../domain/shipment/types.js';

/**
 * 綠界物流狀態碼（RtnCode / LogisticsStatus）→ 平台狀態。
 * ⚠️ 依綠界公開文件整理的常見代碼，正式上線前請以綠界最新「物流狀態代碼表」核對。
 * 未列出的代碼回傳 null：軌跡會保留 raw_status，但不推進平台狀態。
 */
export const ECPAY_STATUS_MAP: Record<string, ShipmentStatus> = {
  // 共用
  '300': 'READY_TO_SHIP', // 訂單處理中（已收到訂單資料）
  '325': 'RETURNING', // 退貨訂單處理中

  // 7-ELEVEN（UNIMART / UNIMARTC2C）
  '2068': 'PICKED_UP', // 交貨便收件（寄件門市已收件）
  '2030': 'IN_TRANSIT', // 物流中心驗收成功
  '2063': 'ARRIVED_AT_STORE', // 門市配達
  '2073': 'ARRIVED_AT_STORE', // 商品配達買家取貨門市
  '2067': 'DELIVERED', // 消費者成功取件
  '2074': 'RETURNING', // 消費者七天未取件
  '2070': 'RETURNING', // 退回原寄件門市
  '2072': 'RETURNED', // 商品已退回原寄件門市，寄件人取回

  // 全家（FAMI / FAMIC2C）
  '3032': 'PICKED_UP', // 賣家已到門市寄件
  '3024': 'IN_TRANSIT', // 貨件已至物流中心
  '3018': 'ARRIVED_AT_STORE', // 到店尚未取貨
  '3022': 'DELIVERED', // 買家已到店取貨
  '3020': 'RETURNING', // 貨件未取退回物流中心
  '3023': 'RETURNED', // 賣家已取退貨
  '3019': 'EXCEPTION', // 退件到店（待寄件人處理）
};

export function mapEcpayStatus(code: string): ShipmentStatus | null {
  return ECPAY_STATUS_MAP[code.trim()] ?? null;
}
